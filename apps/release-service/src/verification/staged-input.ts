import type {
	ReleaseVerificationReport,
	VerifyReleaseInput,
} from "../../../release-verifier/src/verify.js";
import {
	loadWorkloadStagedArtifact,
	WorkloadStagingError,
	workloadArtifactSourceUrl,
} from "../publishing/workload-staging.js";

export type StagedReleaseVerificationReport =
	| ReleaseVerificationReport
	| {
			success: false;
			error: {
				code:
					| WorkloadStagingError["code"]
					| Extract<ReleaseVerificationReport, { success: false }>["error"]["code"];
				message: string;
			};
	  };

interface StagedVerificationIntent {
	id?: string;
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
): Promise<StagedReleaseVerificationReport> {
	const internalArtifact =
		input.artifact.url ===
		workloadArtifactSourceUrl(options.publicOrigin, "package", input.artifact.checksum);
	const internalProvenance =
		input.provenance.url ===
		workloadArtifactSourceUrl(options.publicOrigin, "provenance", input.provenance.checksum);
	const verify = async (
		artifact: Uint8Array,
		provenance: Uint8Array,
	): Promise<ReleaseVerificationReport> => {
		try {
			return await options.verifier.verifyReleaseBytes(input, artifact, provenance);
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "release_verifier_rpc_failed",
					intentId: intent.id,
					packageSlug: intent.packageSlug,
					version: intent.version,
					name: error instanceof Error ? error.name : "UnknownError",
				}),
			);
			return {
				success: false,
				error: {
					code: "VERIFIER_INTERNAL_ERROR",
					message: "The release verifier could not complete its check",
				},
			};
		}
	};
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
		return await verify(artifact.bytes, provenance.bytes);
	} catch (error) {
		const code = error instanceof WorkloadStagingError ? error.code : "FETCH_FAILED";
		console.error(
			JSON.stringify({
				event: "release_staged_input_failed",
				intentId: intent.id,
				packageSlug: intent.packageSlug,
				version: intent.version,
				name: error instanceof Error ? error.name : "UnknownError",
				code,
			}),
		);
		return {
			success: false,
			error: { code, message: "Private staged release bytes are unavailable" },
		};
	}
}
