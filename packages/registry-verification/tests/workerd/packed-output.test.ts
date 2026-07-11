import { expect, it } from "vitest";

import { computeMultihash, GitHubProvenanceVerifier } from "../../dist/index.js";
import bundleFixture from "../../fixtures/provenance/sigstore-core-4.0.1-slsa.bundle.json";

const encoder = new TextEncoder();

it("executes the published verifier bundle in workerd", async () => {
	const document = encoder.encode(JSON.stringify(bundleFixture));
	const checksum = await computeMultihash(document);
	if (!checksum.success) throw new Error("Fixture checksum failed");

	const result = await new GitHubProvenanceVerifier().verify({
		document,
		reference: {
			builderId:
				"https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main",
			checksum: checksum.value,
			predicateType: "https://slsa.dev/provenance/v1",
			sourceRepository: "https://github.com/sigstore/sigstore-js",
			url: "https://registry.npmjs.org/-/npm/v1/attestations/@sigstore%2fcore@4.0.1",
		},
		artifactDigest: Uint8Array.from(
			"f6fe61463ba39f9357abca3b5c511480bc80b5daf9222b1be29cccd39bb72bad484b9ab784fde5b96027764d1190f3cb4d41684db83b55bf38510d5941e6a359".match(
				/.{2}/g,
			) ?? [],
			(byte) => Number.parseInt(byte, 16),
		),
		profileRepository: "https://github.com/sigstore/sigstore-js",
	});

	expect(result).toMatchObject({ success: true });
});
