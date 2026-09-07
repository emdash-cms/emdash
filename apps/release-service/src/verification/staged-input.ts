import type {
	ReleaseVerificationReport,
	VerifyReleaseInput,
} from "../../../release-verifier/src/verify.js";
import {
	loadWorkloadStagedArtifact,
	workloadArtifactSourceUrl,
} from "../publishing/workload-staging.js";

interface StagedVerificationIntent {
	publisherDid: string;
	packageSlug: string;
	version: string;
	workloadIdempotencyDigest: string;
}

interface ReleaseVerifierBinding {
	verifyRelease(input: VerifyReleaseInput): Promise<ReleaseVerificationReport>;
	verifyReleaseBytes(
		input: VerifyReleaseInput,
		artifactBytes: Uint8Array,
		provenanceBytes: Uint8Array,
	): Promise<ReleaseVerificationReport>;
}

export async function verifyReleaseEvidence(
	intent: StagedVerificationIntent,
	input: VerifyReleaseInput,
	options: {
		bucket: R2Bucket;
		publicOrigin: string;
		verifier: ReleaseVerifierBinding;
	},
): Promise<ReleaseVerificationReport> {
	const internalArtifact =
		input.artifact.url ===
		workloadArtifactSourceUrl(options.publicOrigin, "package", input.artifact.checksum);
	const internalProvenance =
		input.provenance.url ===
		workloadArtifactSourceUrl(options.publicOrigin, "provenance", input.provenance.checksum);
	if (!internalArtifact && !internalProvenance) return await options.verifier.verifyRelease(input);
	if (!internalArtifact || !internalProvenance) {
		return {
			success: false,
			error: {
				code: "VERIFIER_INPUT_INVALID",
				message: "Private release sources must include both artifact and provenance uploads",
			},
		};
	}
	try {
		const [artifact, provenance] = await Promise.all([
			loadWorkloadStagedArtifact(options.bucket, {
				publisherDid: intent.publisherDid,
				workloadDigest: intent.workloadIdempotencyDigest,
				packageSlug: intent.packageSlug,
				version: intent.version,
				slot: "package",
				checksum: input.artifact.checksum,
			}),
			loadWorkloadStagedArtifact(options.bucket, {
				publisherDid: intent.publisherDid,
				workloadDigest: intent.workloadIdempotencyDigest,
				packageSlug: intent.packageSlug,
				version: intent.version,
				slot: "provenance",
				checksum: input.provenance.checksum,
			}),
		]);
		return await options.verifier.verifyReleaseBytes(input, artifact.bytes, provenance.bytes);
	} catch {
		return {
			success: false,
			error: { code: "FETCH_FAILED", message: "Private staged release bytes are unavailable" },
		};
	}
}
