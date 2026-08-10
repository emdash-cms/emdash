import {
	canonicalizeDeclaredAccess,
	isPluginSlug,
	isPluginVersion,
} from "@emdash-cms/plugin-types";
import type { CanonicalDeclaredAccess } from "@emdash-cms/plugin-types";
import {
	NSID,
	PackageProfile,
	PackageProfileExtension,
	PackageRelease,
	PackageReleaseExtension,
} from "@emdash-cms/registry-lexicons";

import { compareDigestBytes, decodeMultihash } from "./checksum.js";
import type { VerificationErrorCode } from "./errors.js";
import { GitHubProvenanceVerifier } from "./provenance.js";
import type { ProvenanceVerifier, VerifiedProvenance } from "./provenance.js";
import { canonicalizeRepositoryUrl } from "./repository.js";

export interface NormalizedReleasePolicy {
	requireProvenance: boolean;
	confirmation: "escalation-only" | "always";
	approvers: string[];
}

export interface ProvenanceEvidence {
	document: Uint8Array;
	artifactDigest: Uint8Array;
	verifier?: ProvenanceVerifier;
}

export interface RecordVerificationInput {
	publisherDid: string;
	package: string;
	version: string;
	rkey: string;
	profile: unknown;
	release: unknown;
	provenance?: ProvenanceEvidence;
}

export type RecordVerificationCode =
	| VerificationErrorCode
	| "PROVENANCE_ABSENT_OPTIONAL"
	| "VERIFIED";

export type ProvenanceStatus =
	| "not-checked"
	| "absent-optional"
	| "absent-required"
	| "verified"
	| "failed";

export interface RecordVerificationReason {
	code: RecordVerificationCode;
	message: string;
}

export interface VerifiedRecordContext {
	profile: PackageProfile.Main;
	release: PackageRelease.Main;
	profileExtension: PackageProfileExtension.Main;
	releaseExtension: PackageReleaseExtension.Main;
	repository: string;
	policy: NormalizedReleasePolicy;
	declaredAccess: CanonicalDeclaredAccess;
	verifiedProvenance?: VerifiedProvenance;
}

export type RecordVerificationReport =
	| {
			success: true;
			status: "verified" | "unattested";
			code: "VERIFIED" | "PROVENANCE_ABSENT_OPTIONAL";
			reasons: RecordVerificationReason[];
			provenance: { status: "verified" | "absent-optional" };
			value: VerifiedRecordContext;
	  }
	| {
			success: false;
			status: "failed";
			code: VerificationErrorCode;
			reasons: RecordVerificationReason[];
			provenance: { status: ProvenanceStatus };
	  };

const DEFAULT_POLICY: NormalizedReleasePolicy = {
	requireProvenance: false,
	confirmation: "escalation-only",
	approvers: [],
};

/** Validate signed profile/release records and apply the complete provenance policy. */
export async function verifyPackageReleaseRecords(
	input: RecordVerificationInput,
): Promise<RecordVerificationReport> {
	const profile = await parseLexicon(PackageProfile.mainSchema, input.profile);
	if (!profile) return failed("PROFILE_LEXICON_INVALID", "The package profile is malformed.");

	if (!isPluginSlug(input.package)) {
		return failed("RELEASE_PACKAGE_MISMATCH", "The expected package slug is invalid.");
	}
	const expectedProfileId = `at://${input.publisherDid}/${NSID.packageProfile}/${input.package}`;
	if (
		profile.id !== expectedProfileId ||
		(profile.slug !== undefined && profile.slug !== input.package)
	) {
		return failed(
			"PROFILE_ID_MISMATCH",
			"The profile does not match its authoritative record identity.",
		);
	}

	if (profile.extensions === undefined) {
		return failed("PROFILE_EXTENSION_MISSING", "The signed repository extension is absent.");
	}
	if (!isRecord(profile.extensions)) {
		return failed("PROFILE_EXTENSION_INVALID", "The signed repository extension is malformed.");
	}
	const profileExtensions = profile.extensions;
	const rawProfileExtension = profileExtensions[NSID.packageProfileExtension];
	if (rawProfileExtension === undefined) {
		return failed("PROFILE_EXTENSION_MISSING", "The signed repository extension is absent.");
	}
	const profileExtension = await parseLexicon(
		PackageProfileExtension.mainSchema,
		rawProfileExtension,
	);
	if (!profileExtension) {
		return failed("PROFILE_EXTENSION_INVALID", "The signed repository extension is malformed.");
	}
	const repository = canonicalizeRepositoryUrl(profileExtension.repository);
	if (!repository || repository !== profileExtension.repository) {
		return failed(
			"PROFILE_REPOSITORY_INVALID",
			"The signed repository anchor is not canonical HTTPS.",
		);
	}
	const policy = normalizePolicy(profileExtension.releasePolicy);
	if (!policy) return failed("PROFILE_POLICY_INVALID", "The signed release policy is invalid.");

	const release = await parseLexicon(PackageRelease.mainSchema, input.release);
	if (!release) return failed("RELEASE_LEXICON_INVALID", "The package release is malformed.");
	if (release.package !== input.package) {
		return failed(
			"RELEASE_PACKAGE_MISMATCH",
			"The release package does not match the requested package.",
		);
	}
	if (!isComparablePluginVersion(release.version)) {
		return failed("RELEASE_VERSION_INVALID", "The release version is not canonical semver.");
	}
	if (release.version !== input.version) {
		return failed(
			"RELEASE_VERSION_MISMATCH",
			"The release version does not match the requested version.",
		);
	}
	if (input.rkey !== `${input.package}:${release.version}`) {
		return failed(
			"RELEASE_RKEY_MISMATCH",
			"The release record key does not match package and version.",
		);
	}

	if (release.extensions === undefined) {
		return failed("RELEASE_EXTENSION_MISSING", "The EmDash release extension is absent.");
	}
	if (!isRecord(release.extensions)) {
		return failed("RELEASE_EXTENSION_INVALID", "The EmDash release extension is malformed.");
	}
	const releaseExtensions = release.extensions;
	const rawReleaseExtension = releaseExtensions[NSID.packageReleaseExtension];
	if (rawReleaseExtension === undefined) {
		return failed("RELEASE_EXTENSION_MISSING", "The EmDash release extension is absent.");
	}
	const releaseExtension = await parseLexicon(
		PackageReleaseExtension.mainSchema,
		rawReleaseExtension,
	);
	if (!releaseExtension) {
		return failed("RELEASE_EXTENSION_INVALID", "The EmDash release extension is malformed.");
	}
	const declaredAccess = canonicalizeDeclaredAccess(releaseExtension.declaredAccess);

	if (!releaseExtension.provenance) {
		if (policy.requireProvenance) {
			return failed(
				"PROVENANCE_REQUIRED",
				"The signed policy requires provenance, but the release has none.",
				"absent-required",
			);
		}
		return {
			success: true,
			status: "unattested",
			code: "PROVENANCE_ABSENT_OPTIONAL",
			reasons: [
				{
					code: "PROVENANCE_ABSENT_OPTIONAL",
					message: "The release has no provenance and the signed policy permits it.",
				},
			],
			provenance: { status: "absent-optional" },
			value: {
				profile,
				release,
				profileExtension,
				releaseExtension,
				repository,
				policy,
				declaredAccess,
			},
		};
	}

	if (!input.provenance) {
		return failed(
			"PROVENANCE_UNVERIFIABLE",
			"The release supplies provenance, but no verification evidence was provided.",
			"failed",
		);
	}
	const artifactChecksum = decodeMultihash(release.artifacts.package.checksum);
	if (!artifactChecksum.success) {
		return failed(artifactChecksum.error.code, artifactChecksum.error.message, "failed");
	}
	if (!compareDigestBytes(input.provenance.artifactDigest, artifactChecksum.value.digest)) {
		return failed(
			"CHECKSUM_MISMATCH",
			"The artifact digest does not match the signed package checksum.",
			"failed",
		);
	}
	const verifier = input.provenance.verifier ?? new GitHubProvenanceVerifier();
	let provenanceResult: Awaited<ReturnType<ProvenanceVerifier["verify"]>>;
	try {
		provenanceResult = await verifier.verify({
			document: input.provenance.document,
			reference: releaseExtension.provenance,
			artifactDigest: input.provenance.artifactDigest,
			profileRepository: repository,
		});
	} catch {
		return failed(
			"PROVENANCE_UNVERIFIABLE",
			"The supplied provenance could not be verified.",
			"failed",
		);
	}
	if (!provenanceResult.success) {
		return failed(provenanceResult.error.code, provenanceResult.error.message, "failed");
	}

	return {
		success: true,
		status: "verified",
		code: "VERIFIED",
		reasons: [{ code: "VERIFIED", message: "The signed records and provenance are valid." }],
		provenance: { status: "verified" },
		value: {
			profile,
			release,
			profileExtension,
			releaseExtension,
			repository,
			policy,
			declaredAccess,
			verifiedProvenance: provenanceResult.value,
		},
	};
}

function normalizePolicy(
	value: PackageProfileExtension.ReleasePolicy | undefined,
): NormalizedReleasePolicy | null {
	if (!value) return { ...DEFAULT_POLICY, approvers: [] };
	const confirmation = value.confirmation ?? DEFAULT_POLICY.confirmation;
	if (!isConfirmation(confirmation)) return null;
	const approvers = value.approvers ?? [];
	if (new Set(approvers).size !== approvers.length) return null;
	return {
		requireProvenance: value.requireProvenance ?? false,
		confirmation,
		approvers: [...approvers],
	};
}

function isConfirmation(value: string): value is NormalizedReleasePolicy["confirmation"] {
	return value === "always" || value === "escalation-only";
}

function isComparablePluginVersion(value: string): boolean {
	if (!isPluginVersion(value)) return false;
	const prereleaseSeparator = value.indexOf("-");
	const core = value.slice(0, prereleaseSeparator === -1 ? undefined : prereleaseSeparator);
	return core.split(".").every((component) => Number.isSafeInteger(Number(component)));
}

function failed(
	code: VerificationErrorCode,
	message: string,
	provenance: ProvenanceStatus = "not-checked",
): RecordVerificationReport {
	return {
		success: false,
		status: "failed",
		code,
		reasons: [{ code, message }],
		provenance: { status: provenance },
	};
}

interface StandardSchema<T> {
	readonly "~standard": {
		validate(
			value: unknown,
		):
			| { value: T; issues?: undefined }
			| { value?: undefined; issues: readonly unknown[] }
			| Promise<
					{ value: T; issues?: undefined } | { value?: undefined; issues: readonly unknown[] }
			  >;
	};
}

async function parseLexicon<T>(schema: StandardSchema<T>, value: unknown): Promise<T | null> {
	const result = await schema["~standard"].validate(value);
	return result.issues ? null : result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
