import { WorkerEntrypoint } from "cloudflare:workers";

import {
	verifyArtifact,
	verifyRelease,
	verifyReleaseBytes,
	type ArtifactVerificationReport,
	type ReleaseVerificationReport,
	type VerifyArtifactInput,
	type VerifyReleaseInput,
} from "./verify.js";

export default class ReleaseVerifier extends WorkerEntrypoint<Env> {
	override fetch(_request: Request): Response {
		return new Response(null, { status: 404 });
	}

	async verifyArtifact(input: VerifyArtifactInput): Promise<ArtifactVerificationReport> {
		return verifyArtifact(input);
	}

	async verifyRelease(input: VerifyReleaseInput): Promise<ReleaseVerificationReport> {
		return verifyRelease(input);
	}

	async verifyReleaseBytes(
		input: VerifyReleaseInput,
		artifactBytes: Uint8Array,
		provenanceBytes: Uint8Array,
	): Promise<ReleaseVerificationReport> {
		return verifyReleaseBytes(input, artifactBytes, provenanceBytes);
	}
}
