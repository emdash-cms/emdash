import {
	MAX_BUNDLE_COMPRESSED_BYTES,
	GitHubProvenanceVerifier,
	computeArtifactDigestCandidates,
	fetchVerifiedResource,
	validatePluginBundle,
	verifyMultihash,
	type FetchImplementation,
	type HostnameResolver,
	type ProvenanceVerifier,
	type ReleaseProvenance,
	type ValidatedPluginBundle,
	type VerificationErrorCode,
} from "@emdash-cms/registry-verification";

import { resolvePublicHostname } from "./dns.js";

const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const CHECKSUM_PATTERN = /^b[a-z2-7]+$/;
const MAX_PROVENANCE_BYTES = 5 * 1024 * 1024;
const PROVENANCE_TYPE = "com.emdashcms.experimental.package.releaseExtension#provenance";
const PROVENANCE_KEYS = new Set([
	"$type",
	"url",
	"checksum",
	"builderId",
	"predicateType",
	"sourceRepository",
]);

export interface VerifyArtifactInput {
	url: string;
	checksum: string;
	packageSlug: string;
	version: string;
}

export interface VerifiedArtifactReport {
	requestedUrl: string;
	resolvedUrl: string;
	checksum: string;
	compressedBytes: number;
	manifest: {
		id: string;
		version: string;
		declaredAccess: ValidatedPluginBundle["declaredAccess"];
	};
	bundle: {
		backendBytes: number;
		adminBytes: number | null;
	};
}

export type ArtifactVerificationReport =
	| { success: true; value: VerifiedArtifactReport }
	| {
			success: false;
			error: {
				code: VerificationErrorCode | "VERIFIER_INPUT_INVALID" | "VERIFIER_INTERNAL_ERROR";
				message: string;
			};
	  };

type VerifierError = ArtifactVerificationReport & { success: false };

export interface VerifyReleaseInput {
	artifact: VerifyArtifactInput;
	provenance: ReleaseProvenance;
	profileRepository: string;
}

export interface VerifiedReleaseReport {
	artifact: VerifiedArtifactReport;
	provenance: {
		requestedUrl: string;
		resolvedUrl: string;
		checksum: string;
		documentBytes: number;
		predicateType: string;
		sourceRepository: string;
		builderId: string;
		repositoryId: string;
		workflowRef: string;
		commitSha: string;
		invocationId: string;
		artifactDigest: Uint8Array;
	};
}

export type ReleaseVerificationReport =
	| { success: true; value: VerifiedReleaseReport }
	| VerifierError;

export interface VerifierDependencies {
	fetch: FetchImplementation;
	resolveHostname: HostnameResolver;
	provenanceVerifier?: ProvenanceVerifier;
}

function validInput(input: VerifyArtifactInput): boolean {
	return (
		input !== null &&
		typeof input === "object" &&
		Object.keys(input).length === 4 &&
		typeof input.url === "string" &&
		input.url.length <= 2048 &&
		typeof input.checksum === "string" &&
		CHECKSUM_PATTERN.test(input.checksum) &&
		PACKAGE_SLUG_PATTERN.test(input.packageSlug) &&
		VERSION_PATTERN.test(input.version)
	);
}

function invalidInput(message: string): VerifierError {
	return { success: false, error: { code: "VERIFIER_INPUT_INVALID", message } };
}

function internalError(message = "Artifact verification failed"): VerifierError {
	return {
		success: false,
		error: { code: "VERIFIER_INTERNAL_ERROR", message },
	};
}

function validReleaseInput(input: VerifyReleaseInput): boolean {
	return (
		input !== null &&
		typeof input === "object" &&
		Object.keys(input).length === 3 &&
		validInput(input.artifact) &&
		typeof input.profileRepository === "string" &&
		input.profileRepository.length <= 2048 &&
		input.provenance !== null &&
		typeof input.provenance === "object" &&
		Object.keys(input.provenance).every((key) => PROVENANCE_KEYS.has(key)) &&
		(input.provenance.$type === undefined || input.provenance.$type === PROVENANCE_TYPE) &&
		typeof input.provenance.url === "string" &&
		input.provenance.url.length <= 2048 &&
		typeof input.provenance.checksum === "string" &&
		CHECKSUM_PATTERN.test(input.provenance.checksum) &&
		typeof input.provenance.builderId === "string" &&
		input.provenance.builderId.length <= 2048 &&
		typeof input.provenance.predicateType === "string" &&
		input.provenance.predicateType.length <= 256 &&
		typeof input.provenance.sourceRepository === "string" &&
		input.provenance.sourceRepository.length <= 2048
	);
}

async function loadArtifact(
	input: VerifyArtifactInput,
	dependencies: VerifierDependencies,
): Promise<
	{ success: true; value: { bytes: Uint8Array; report: VerifiedArtifactReport } } | VerifierError
> {
	const resource = await fetchVerifiedResource(input.url, {
		...dependencies,
		maxBytes: MAX_BUNDLE_COMPRESSED_BYTES,
	});
	if (!resource.success) return resource;
	return await verifyArtifactBytes(input, resource.value.bytes, resource.value.url.toString());
}

async function verifyArtifactBytes(
	input: VerifyArtifactInput,
	bytes: Uint8Array,
	resolvedUrl: string,
): Promise<
	{ success: true; value: { bytes: Uint8Array; report: VerifiedArtifactReport } } | VerifierError
> {
	if (bytes.byteLength < 1 || bytes.byteLength > MAX_BUNDLE_COMPRESSED_BYTES) {
		return invalidInput("Artifact bytes are invalid");
	}
	const checksum = await verifyMultihash(bytes, input.checksum);
	if (!checksum.success) return checksum;
	const bundle = await validatePluginBundle(bytes, {
		expectedSlug: input.packageSlug,
		expectedVersion: input.version,
	});
	if (!bundle.success) return bundle;
	return {
		success: true,
		value: {
			bytes,
			report: {
				requestedUrl: input.url,
				resolvedUrl,
				checksum: input.checksum,
				compressedBytes: bytes.byteLength,
				manifest: {
					id: bundle.value.manifest.id,
					version: bundle.value.manifest.version,
					declaredAccess: bundle.value.declaredAccess,
				},
				bundle: {
					backendBytes: bundle.value.backend.byteLength,
					adminBytes: bundle.value.admin?.byteLength ?? null,
				},
			},
		},
	};
}

async function verifyLoadedRelease(
	input: VerifyReleaseInput,
	artifact: { bytes: Uint8Array; report: VerifiedArtifactReport },
	provenanceBytes: Uint8Array,
	provenanceResolvedUrl: string,
	provenanceVerifier: ProvenanceVerifier,
): Promise<ReleaseVerificationReport> {
	if (provenanceBytes.byteLength < 1 || provenanceBytes.byteLength > MAX_PROVENANCE_BYTES) {
		return invalidInput("Provenance bytes are invalid");
	}
	const provenanceChecksum = await verifyMultihash(provenanceBytes, input.provenance.checksum);
	if (!provenanceChecksum.success) return provenanceChecksum;
	const artifactDigests = await computeArtifactDigestCandidates(artifact.bytes);
	const [artifactDigest, ...additionalDigests] = artifactDigests;
	if (!artifactDigest) return internalError("Release verification failed");
	const provenance = await provenanceVerifier.verify({
		document: provenanceBytes,
		reference: input.provenance,
		artifactDigest,
		artifactDigests: additionalDigests,
		profileRepository: input.profileRepository,
	});
	if (!provenance.success) return provenance;
	if (
		!("repositoryId" in provenance.value) ||
		typeof provenance.value.repositoryId !== "string" ||
		!("workflowRef" in provenance.value) ||
		typeof provenance.value.workflowRef !== "string" ||
		!("commitSha" in provenance.value) ||
		typeof provenance.value.commitSha !== "string" ||
		!("invocationId" in provenance.value) ||
		typeof provenance.value.invocationId !== "string"
	) {
		return internalError("Release verification failed");
	}
	return {
		success: true,
		value: {
			artifact: artifact.report,
			provenance: {
				requestedUrl: input.provenance.url,
				resolvedUrl: provenanceResolvedUrl,
				checksum: input.provenance.checksum,
				documentBytes: provenanceBytes.byteLength,
				predicateType: provenance.value.predicateType,
				sourceRepository: provenance.value.sourceRepository,
				builderId: provenance.value.builderId,
				repositoryId: provenance.value.repositoryId,
				workflowRef: provenance.value.workflowRef,
				commitSha: provenance.value.commitSha,
				invocationId: provenance.value.invocationId,
				artifactDigest: provenance.value.artifactDigest.slice(),
			},
		},
	};
}

export async function verifyArtifact(
	input: VerifyArtifactInput,
	dependencies: VerifierDependencies = {
		fetch: (url, init) => fetch(url, init),
		resolveHostname: resolvePublicHostname,
	},
): Promise<ArtifactVerificationReport> {
	if (!validInput(input)) {
		return invalidInput("Artifact request is invalid");
	}
	try {
		const loaded = await loadArtifact(input, dependencies);
		return loaded.success ? { success: true, value: loaded.value.report } : loaded;
	} catch {
		return internalError();
	}
}

export async function verifyRelease(
	input: VerifyReleaseInput,
	dependencies: VerifierDependencies = {
		fetch: (url, init) => fetch(url, init),
		resolveHostname: resolvePublicHostname,
	},
): Promise<ReleaseVerificationReport> {
	if (!validReleaseInput(input)) return invalidInput("Release verification request is invalid");
	try {
		const artifact = await loadArtifact(input.artifact, dependencies);
		if (!artifact.success) return artifact;
		const provenanceResource = await fetchVerifiedResource(input.provenance.url, {
			...dependencies,
			maxBytes: MAX_PROVENANCE_BYTES,
		});
		if (!provenanceResource.success) return provenanceResource;
		return await verifyLoadedRelease(
			input,
			artifact.value,
			provenanceResource.value.bytes,
			provenanceResource.value.url.toString(),
			dependencies.provenanceVerifier ?? new GitHubProvenanceVerifier(),
		);
	} catch {
		return internalError("Release verification failed");
	}
}

export async function verifyReleaseBytes(
	input: VerifyReleaseInput,
	artifactBytes: Uint8Array,
	provenanceBytes: Uint8Array,
	provenanceVerifier: ProvenanceVerifier = new GitHubProvenanceVerifier(),
): Promise<ReleaseVerificationReport> {
	if (
		!validReleaseInput(input) ||
		!(artifactBytes instanceof Uint8Array) ||
		!(provenanceBytes instanceof Uint8Array)
	) {
		return invalidInput("Release verification request is invalid");
	}
	try {
		const artifact = await verifyArtifactBytes(input.artifact, artifactBytes, input.artifact.url);
		if (!artifact.success) return artifact;
		return await verifyLoadedRelease(
			input,
			artifact.value,
			provenanceBytes,
			input.provenance.url,
			provenanceVerifier,
		);
	} catch {
		return internalError("Release verification failed");
	}
}
