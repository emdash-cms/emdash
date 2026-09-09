import type {
	DirectPdsDidDocumentResolver,
	DirectPdsProfileRecord,
	DirectPdsReadErrorCode,
	DirectPdsReleaseRecord,
} from "@emdash-cms/registry-client/direct-pds";
import { DirectPdsClient, DirectPdsReadError } from "@emdash-cms/registry-client/direct-pds";
import {
	fetchVerifiedResource,
	inspectPackageReleaseRecords,
	verifyMultihash,
	verifyPackageReleaseRecords,
	type FetchImplementation,
	type HostnameResolver,
	type ProvenanceVerifier,
	type RecordInspectionReport,
	type RecordVerificationFailure,
	type RecordVerificationReport,
	type VerificationErrorCode,
} from "@emdash-cms/registry-verification";

import { cloudflareDohResolver, ssrfSafeFetch } from "../security/ssrf.js";

const MAX_PROVENANCE_BYTES = 5 * 1024 * 1024;

export type AuthoritativeRecordErrorCode =
	| DirectPdsReadErrorCode
	| VerificationErrorCode
	| "AUTHORITATIVE_RECORD_READ_FAILED";

export interface AuthoritativeRecordReadOptions {
	fetch?: typeof fetch;
	didDocumentResolver?: DirectPdsDidDocumentResolver;
	provenanceFetch?: FetchImplementation;
	resolveHostname?: HostnameResolver;
	provenanceVerifier?: ProvenanceVerifier;
	artifactDigests?: readonly Uint8Array[];
}

export interface VerifiedAuthoritativeRecords {
	publisherDid: string;
	packageSlug: string;
	version: string;
	profile: DirectPdsProfileRecord;
	release: DirectPdsReleaseRecord;
	inspection: Extract<RecordInspectionReport, { success: true }>;
}

export type VerifiedAuthoritativeReleaseReport = Extract<
	RecordVerificationReport,
	{ success: true }
>;

export type AuthoritativeRecordReadResult =
	| { success: true; value: VerifiedAuthoritativeRecords }
	| {
			success: false;
			error: { code: AuthoritativeRecordErrorCode; message: string };
	  };

export type AuthoritativeRecordReader = (
	publisherDid: string,
	packageSlug: string,
	version: string,
	options?: AuthoritativeRecordReadOptions,
) => Promise<AuthoritativeRecordReadResult>;

export async function readAuthoritativePackageRelease(
	publisherDid: string,
	packageSlug: string,
	version: string,
	options: AuthoritativeRecordReadOptions = {},
): Promise<AuthoritativeRecordReadResult> {
	try {
		const client = new DirectPdsClient({
			did: publisherDid,
			fetch: options.fetch ?? guardedFetch,
			didDocumentResolver: options.didDocumentResolver,
		});
		const [profile, release] = await Promise.all([
			client.getPackageProfile(packageSlug),
			client.getPackageRelease(packageSlug, version),
		]);
		const inspection = await inspectPackageReleaseRecords({
			publisherDid,
			package: packageSlug,
			version,
			rkey: release.rkey,
			profile: profile.value,
			release: release.value,
		});
		if (!inspection.success) {
			return {
				success: false,
				error: {
					code: inspection.code,
					message: inspection.reasons[0]?.message ?? "The signed package records are invalid.",
				},
			};
		}
		return {
			success: true,
			value: { publisherDid, packageSlug, version, profile, release, inspection },
		};
	} catch (error) {
		if (error instanceof DirectPdsReadError) {
			return { success: false, error: { code: error.code, message: error.message } };
		}
		return {
			success: false,
			error: {
				code: "AUTHORITATIVE_RECORD_READ_FAILED",
				message: "The publisher's signed package records could not be verified.",
			},
		};
	}
}

export async function verifyAuthoritativePackageRelease(
	records: VerifiedAuthoritativeRecords,
	artifactDigest: Uint8Array,
	options: AuthoritativeRecordReadOptions = {},
): Promise<RecordVerificationReport> {
	const context = records.inspection.value;
	const provenanceReference = context.releaseExtension.provenance;
	let document: Uint8Array | undefined;
	if (provenanceReference) {
		const fetched = await fetchVerifiedResource(provenanceReference.url, {
			fetch: options.provenanceFetch ?? defaultProvenanceFetch,
			resolveHostname: options.resolveHostname ?? cloudflareDohResolver,
			maxBytes: MAX_PROVENANCE_BYTES,
		});
		if (!fetched.success) {
			return verificationFailure(fetched.error.code, fetched.error.message);
		}
		const checksum = await verifyMultihash(fetched.value.bytes, provenanceReference.checksum);
		if (!checksum.success) {
			return verificationFailure(checksum.error.code, checksum.error.message);
		}
		document = fetched.value.bytes;
	}

	return verifyPackageReleaseRecords({
		publisherDid: records.publisherDid,
		package: records.packageSlug,
		version: records.version,
		rkey: records.release.rkey,
		profile: records.profile.value,
		release: records.release.value,
		provenance:
			document === undefined
				? undefined
				: {
						document,
						artifactDigest,
						artifactDigests: options.artifactDigests,
						verifier: options.provenanceVerifier,
					},
	});
}

function verificationFailure(
	code: VerificationErrorCode,
	message: string,
): RecordVerificationFailure {
	return {
		success: false,
		status: "failed",
		code,
		reasons: [{ code, message }],
		provenance: { status: "failed" },
	};
}

const guardedFetch: typeof fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	return ssrfSafeFetch(url, init, { httpsOnly: true });
};

const defaultProvenanceFetch: FetchImplementation = (input, init) => globalThis.fetch(input, init);
