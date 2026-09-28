import { computeMultihash } from "@emdash-cms/registry-verification";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VerifyReleaseInput } from "../../release-verifier/src/verify.js";
import {
	persistWorkloadStagedArtifact,
	workloadArtifactSourceUrl,
} from "../src/publishing/workload-staging.js";
import { verifyReleaseEvidence } from "../src/verification/staged-input.js";

const PUBLISHER_DID = "did:plc:publisher";
const WORKLOAD_DIGEST = "A".repeat(43);
const ORIGIN = "https://release.example.com";
const PACKAGE = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);
const PROVENANCE = new TextEncoder().encode('{"sigstore":"bundle"}');

async function checksum(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new Error(result.error.code);
	return result.value;
}

afterEach(async () => {
	await reset();
});

describe("staged release verification", () => {
	it("sends exact private R2 bytes to the isolated verifier", async () => {
		const packageChecksum = await checksum(PACKAGE);
		const provenanceChecksum = await checksum(PROVENANCE);
		for (const artifact of [
			{
				slot: "package" as const,
				bytes: PACKAGE,
				checksum: packageChecksum,
				contentType: "application/gzip",
			},
			{
				slot: "provenance" as const,
				bytes: PROVENANCE,
				checksum: provenanceChecksum,
				contentType: "application/json",
			},
		]) {
			await persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, {
				publisherDid: PUBLISHER_DID,
				workloadDigest: WORKLOAD_DIGEST,
				packageSlug: "gallery",
				version: "1.2.3",
				slot: artifact.slot,
				checksum: artifact.checksum,
				contentType: artifact.contentType,
				contentLength: artifact.bytes.byteLength,
				body: new Response(artifact.bytes).body!,
			});
		}
		const input: VerifyReleaseInput = {
			artifact: {
				url: workloadArtifactSourceUrl(ORIGIN, "package", packageChecksum),
				checksum: packageChecksum,
				packageSlug: "gallery",
				version: "1.2.3",
			},
			provenance: {
				url: workloadArtifactSourceUrl(ORIGIN, "provenance", provenanceChecksum),
				checksum: provenanceChecksum,
				predicateType: "https://slsa.dev/provenance/v1",
				sourceRepository: "https://github.com/example/gallery",
				builderId:
					"https://github.com/example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
			},
			profileRepository: "https://github.com/example/gallery",
		};
		const verifyReleaseBytes = vi.fn(async () => ({
			success: false as const,
			error: { code: "VERIFIER_INTERNAL_ERROR" as const, message: "verified private bytes" },
		}));
		const verifyRelease = vi.fn();

		await expect(
			verifyReleaseEvidence(
				{
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					workloadIdempotencyDigest: WORKLOAD_DIGEST,
				},
				input,
				{
					bucket: env.PUBLICATION_STAGING,
					publicOrigin: ORIGIN,
					verifier: { verifyRelease, verifyReleaseBytes },
				},
			),
		).resolves.toMatchObject({ error: { message: "verified private bytes" } });
		expect(verifyRelease).not.toHaveBeenCalled();
		expect(verifyReleaseBytes).toHaveBeenCalledWith(input, PACKAGE, PROVENANCE);
	});

	it("preserves URL verification for existing hand-authored release records", async () => {
		const input: VerifyReleaseInput = {
			artifact: {
				url: "https://example.com/plugin.tgz",
				checksum: await checksum(PACKAGE),
				packageSlug: "gallery",
				version: "1.2.3",
			},
			provenance: {
				url: "https://example.com/provenance.json",
				checksum: await checksum(PROVENANCE),
				predicateType: "https://slsa.dev/provenance/v1",
				sourceRepository: "https://github.com/example/gallery",
				builderId:
					"https://github.com/example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
			},
			profileRepository: "https://github.com/example/gallery",
		};
		const report = {
			success: false as const,
			error: { code: "VERIFIER_INTERNAL_ERROR" as const, message: "external" },
		};
		const verifyRelease = vi.fn(async () => report);

		await expect(
			verifyReleaseEvidence(
				{
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					workloadIdempotencyDigest: WORKLOAD_DIGEST,
				},
				input,
				{
					bucket: env.PUBLICATION_STAGING,
					publicOrigin: ORIGIN,
					verifier: { verifyRelease, verifyReleaseBytes: vi.fn() },
				},
			),
		).resolves.toBe(report);
		expect(verifyRelease).toHaveBeenCalledWith(input);
	});
});
