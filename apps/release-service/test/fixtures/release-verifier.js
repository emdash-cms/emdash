import { WorkerEntrypoint } from "cloudflare:workers";

export default class TestReleaseVerifier extends WorkerEntrypoint {
	fetchArtifact(url) {
		if (url.endsWith("/unavailable")) throw new Error("internal service address");
		return { success: true, value: new Uint8Array([7]) };
	}

	fetchProvenance() {
		return { success: true, value: "not bytes" };
	}
}
