import { computeMultihash } from "@emdash-cms/registry-verification";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	handleGetPublishedProvenance,
	matchPublishedProvenancePath,
} from "../src/publishing/provenance-routes.js";
import {
	deleteWorkloadStagedArtifacts,
	loadWorkloadStagedArtifact,
	persistWorkloadStagedArtifact,
	promoteWorkloadProvenance,
	WorkloadStagingError,
	workloadArtifactSourceUrl,
} from "../src/publishing/workload-staging.js";

const PUBLISHER_DID = "did:plc:publisher";
const WORKLOAD_DIGEST = "A".repeat(43);
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);

async function checksum(bytes: Uint8Array = BYTES): Promise<string> {
	const result = await computeMultihash(new Uint8Array(bytes));
	if (!result.success) throw new Error(result.error.code);
	return result.value;
}

function input(bytes: Uint8Array = BYTES) {
	return {
		publisherDid: PUBLISHER_DID,
		workloadDigest: WORKLOAD_DIGEST,
		packageSlug: "gallery",
		version: "1.2.3",
		slot: "package" as const,
		checksum: "",
		contentType: "application/gzip",
		contentLength: bytes.byteLength,
		body: new Response(new Uint8Array(bytes)).body!,
	};
}

afterEach(async () => {
	await reset();
});

describe("workload artifact staging", () => {
	it("streams a checksum-bound upload to a deterministic private object", async () => {
		const value = input();
		value.checksum = await checksum();
		const first = await persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, value);
		const replay = await persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, {
			...value,
			body: new Response(BYTES).body!,
		});

		expect(replay).toEqual({ ...first, replayed: true });
		await expect(
			loadWorkloadStagedArtifact(env.PUBLICATION_STAGING, {
				publisherDid: PUBLISHER_DID,
				workloadDigest: WORKLOAD_DIGEST,
				packageSlug: "gallery",
				version: "1.2.3",
				slot: "package",
				checksum: value.checksum,
			}),
		).resolves.toMatchObject({ bytes: BYTES, contentType: "application/gzip" });
	});

	it("rejects a body that exceeds its declared bounded length without retaining it", async () => {
		const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]);
		const value = input(bytes);
		value.checksum = await checksum(bytes);
		value.contentLength = bytes.byteLength - 1;

		await expect(
			persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, value),
		).rejects.toMatchObject({ code: "WORKLOAD_STAGING_SIZE_MISMATCH" });
		expect((await env.PUBLICATION_STAGING.list({ prefix: "workload/" })).objects).toHaveLength(0);
	});

	it("refuses changed bytes in the same run, package, version, and slot", async () => {
		const first = input();
		first.checksum = await checksum();
		await persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, first);
		const changedBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x02]);
		const changed = input(changedBytes);
		changed.checksum = await checksum(changedBytes);

		await expect(
			persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, changed),
		).rejects.toBeInstanceOf(WorkloadStagingError);
	});

	it("promotes verified provenance to an immutable public evidence key", async () => {
		const provenance = new TextEncoder().encode(
			'{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
		);
		const value = {
			...input(provenance),
			slot: "provenance" as const,
			contentType: "application/json",
			checksum: await checksum(provenance),
		};
		await persistWorkloadStagedArtifact(env.PUBLICATION_STAGING, value);
		const promoted = await promoteWorkloadProvenance(
			env.PUBLICATION_STAGING,
			env.PROVENANCE_STORE,
			{
				publisherDid: PUBLISHER_DID,
				workloadDigest: WORKLOAD_DIGEST,
				packageSlug: "gallery",
				version: "1.2.3",
				checksum: value.checksum,
			},
		);

		expect(promoted.key).toBe(`provenance/${value.checksum}`);
		expect(await (await env.PROVENANCE_STORE.get(promoted.key))?.bytes()).toEqual(provenance);
		expect(
			workloadArtifactSourceUrl("https://release.example.com", "provenance", value.checksum),
		).toBe(`https://release.example.com/v1/provenance/${value.checksum}`);
		const params = matchPublishedProvenancePath(`/v1/provenance/${value.checksum}`);
		expect(params).toEqual({ checksum: value.checksum });
		const response = await handleGetPublishedProvenance(
			new Request(`https://release.example.com/v1/provenance/${value.checksum}`),
			"request-provenance",
			params!,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(provenance);
		await deleteWorkloadStagedArtifacts(env.PUBLICATION_STAGING, [
			{
				publisherDid: PUBLISHER_DID,
				workloadDigest: WORKLOAD_DIGEST,
				packageSlug: "gallery",
				version: "1.2.3",
				slot: "provenance",
				checksum: value.checksum,
			},
		]);
		expect((await env.PUBLICATION_STAGING.list({ prefix: "workload/" })).objects).toHaveLength(0);
		expect(await env.PROVENANCE_STORE.head(promoted.key)).not.toBeNull();
	});
});
