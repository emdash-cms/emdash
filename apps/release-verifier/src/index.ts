import { WorkerEntrypoint } from "cloudflare:workers";

import {
	verifyArtifact,
	verifyRelease,
	type ArtifactVerificationReport,
	type ReleaseVerificationReport,
	type VerifyArtifactInput,
	type VerifyReleaseInput,
} from "./verify.js";

export default class ReleaseVerifier extends WorkerEntrypoint<Env> {
	async verifyArtifact(input: VerifyArtifactInput): Promise<ArtifactVerificationReport> {
		return verifyArtifact(input);
	}

	async verifyRelease(input: VerifyReleaseInput): Promise<ReleaseVerificationReport> {
		return verifyRelease(input);
	}
}
