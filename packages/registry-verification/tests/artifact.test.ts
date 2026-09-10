import { describe, expect, it, vi } from "vitest";

import { fetchReleaseArtifact, recordScopedBlobCacheUrl } from "../src/index.js";

const bytes = new TextEncoder().encode("bundle");
const cid = "bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q";
const checksum = "bciqb43wwlv35mnso5lwvu5c3uxcjqwxcw4an3boxz57qe667fffdh7a";
const publisherDid = "did:plc:abcdefghijklmnopqrstuvwx";
const record = {
	did: publisherDid,
	collection: "com.emdashcms.experimental.package.release",
	rkey: "gallery:1.2.3",
	cid: "bafyreig7jlyqew5vpur7kzjk5nwz7kx7f2jvcm2payqv6xnaylb3h5or7a",
};
const cache = {
	$type: "com.emdashcms.experimental.aggregator.defs#recordScopedBlobCache",
	serviceEndpoint: "https://cumulus.example",
};
const resolveHostname = async (): Promise<readonly string[]> => ["203.0.113.5"];

function artifact(overrides: Record<string, unknown> = {}) {
	return {
		blob: {
			$type: "blob" as const,
			ref: { $link: cid },
			mimeType: "application/gzip",
			size: bytes.byteLength,
		},
		url: "https://origin.example/plugin.tgz",
		checksum,
		...overrides,
	};
}

describe("fetchReleaseArtifact", () => {
	it("uses a record-scoped artifact cache before the publisher PDS", async () => {
		const fetch = vi.fn(async (url: URL) => {
			if (url.hostname === "cumulus.example") return new Response(bytes);
			return new Response(null, { status: 500 });
		});

		const result = await fetchReleaseArtifact(
			{
				artifact: artifact(),
				record,
				artifactCaches: [cache],
			},
			{ fetch, resolveHostname },
		);

		expect(result).toMatchObject({ success: true, value: { source: "artifact-cache", bytes } });
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[0].pathname).toBe(
			`/r/${record.did}/${record.collection}/${record.rkey}/${record.cid}/${cid}`,
		);
	});

	it("falls through an unavailable artifact cache to the publisher PDS blob", async () => {
		const fetch = vi.fn(async (url: URL) => {
			if (url.hostname === "cumulus.example") return new Response(null, { status: 503 });
			if (url.hostname === "plc.directory") {
				return Response.json({
					id: publisherDid,
					service: [
						{
							id: `${publisherDid}#atproto_pds`,
							type: "AtprotoPersonalDataServer",
							serviceEndpoint: "https://pds.example",
						},
					],
				});
			}
			if (url.hostname === "pds.example") return new Response(bytes);
			return new Response(null, { status: 500 });
		});

		const result = await fetchReleaseArtifact(
			{
				artifact: artifact(),
				record,
				artifactCaches: [cache],
			},
			{ fetch, resolveHostname },
		);

		expect(result).toMatchObject({ success: true, value: { source: "blob", bytes } });
		const blobUrl = fetch.mock.calls
			.map(([url]) => url)
			.find((url) => url.hostname === "pds.example");
		expect(blobUrl?.pathname).toBe("/xrpc/com.atproto.sync.getBlob");
		expect(blobUrl?.searchParams.get("did")).toBe(publisherDid);
		expect(blobUrl?.searchParams.get("cid")).toBe(cid);
	});

	it("ignores unrecognised artifact cache variants", async () => {
		const fetch = vi.fn(async (url: URL) => {
			if (url.hostname === "pds.example") return new Response(bytes);
			return new Response(null, { status: 500 });
		});

		const result = await fetchReleaseArtifact(
			{
				artifact: artifact(),
				record,
				pdsEndpoint: "https://pds.example",
				artifactCaches: [
					{
						$type: "com.example.unknownCache",
						serviceEndpoint: "https://unknown-cache.example",
					},
				],
			},
			{ fetch, resolveHostname },
		);

		expect(result).toMatchObject({ success: true, value: { source: "blob", bytes } });
		expect(fetch.mock.calls.some(([url]) => url.hostname === "unknown-cache.example")).toBe(false);
	});

	it("falls through an unavailable blob to the declared URL", async () => {
		const fetch = vi.fn(async (url: URL) => {
			if (url.hostname === "pds.example") return new Response(null, { status: 404 });
			if (url.hostname === "origin.example") return new Response(bytes);
			return new Response(null, { status: 500 });
		});

		const result = await fetchReleaseArtifact(
			{ artifact: artifact(), record, pdsEndpoint: "https://pds.example" },
			{ fetch, resolveHostname },
		);

		expect(result).toMatchObject({ success: true, value: { source: "url", bytes } });
	});

	it("fetches a blob from an explicitly allowed loopback PDS", async () => {
		const fetch = vi.fn(async () => new Response(bytes));
		const result = await fetchReleaseArtifact(
			{
				artifact: artifact({ url: undefined }),
				record,
				pdsEndpoint: "http://localhost:2583",
			},
			{
				fetch,
				resolveHostname: async () => [],
				allowHttpLocalhost: true,
			},
		);

		expect(result).toMatchObject({ success: true, value: { source: "blob", bytes } });
		expect(fetch.mock.calls[0]?.[0].origin).toBe("http://localhost:2583");
	});

	it("rejects fetched bytes that disagree with signed blob metadata", async () => {
		for (const blob of [
			{ ...artifact().blob!, size: bytes.byteLength - 1 },
			{ ...artifact().blob!, mimeType: "image/png" },
		]) {
			const result = await fetchReleaseArtifact(
				{
					artifact: artifact({ blob, url: undefined }),
					record,
					pdsEndpoint: "https://pds.example",
				},
				{
					fetch: async () =>
						new Response(bytes, { headers: { "content-type": "application/gzip" } }),
					resolveHostname,
				},
			);

			expect(result).toMatchObject({
				success: false,
				error: { code: "BLOB_METADATA_MISMATCH" },
			});
		}
	});

	it("rejects a blob whose CID disagrees with its checksum before fetching", async () => {
		const fetch = vi.fn();
		const result = await fetchReleaseArtifact(
			{ artifact: artifact({ checksum: "bciqinvalid" }), record },
			{ fetch, resolveHostname },
		);

		expect(result).toMatchObject({ success: false, error: { code: "CHECKSUM_MISMATCH" } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects artifacts without a blob or URL", async () => {
		const result = await fetchReleaseArtifact(
			{ artifact: artifact({ blob: undefined, url: undefined }), record },
			{ fetch: vi.fn(), resolveHostname },
		);

		expect(result).toMatchObject({
			success: false,
			error: { code: "RELEASE_ARTIFACT_SOURCE_MISSING" },
		});
	});

	it("returns only a safe help URL for an unsupported authentication method", async () => {
		const result = await fetchReleaseArtifact(
			{
				artifact: artifact({ requiresAuth: true }),
				record,
				auth: {
					$type: "com.example.package.auth",
					hint: "Sign in to the publisher account",
					hint_url: "https://example.com/help",
				},
			},
			{ fetch: vi.fn(), resolveHostname },
		);

		expect(result).toMatchObject({
			success: false,
			error: {
				code: "AUTH_METHOD_UNSUPPORTED",
				message: "This release requires an authentication method the client does not support.",
				details: {
					hintUrl: "https://example.com/help",
				},
			},
		});
	});

	it("drops unsafe authentication help URLs", async () => {
		const result = await fetchReleaseArtifact(
			{
				artifact: artifact({ requiresAuth: true }),
				record,
				auth: {
					hint: "<script>alert(1)</script>",
					hint_url: "javascript:alert(1)",
				},
			},
			{ fetch: vi.fn(), resolveHostname },
		);

		expect(result).toEqual({
			success: false,
			error: {
				code: "AUTH_METHOD_UNSUPPORTED",
				message: "This release requires an authentication method the client does not support.",
			},
		});
	});
});

describe("recordScopedBlobCacheUrl", () => {
	it("rejects a route that does not bind valid record and blob CIDs", () => {
		expect(
			recordScopedBlobCacheUrl("https://cumulus.example", { ...record, cid: "not-a-cid" }, cid),
		).toMatchObject({ success: false, error: { code: "INVALID_URL" } });
		expect(recordScopedBlobCacheUrl("https://cumulus.example", record, "not-a-cid")).toMatchObject({
			success: false,
			error: { code: "INVALID_URL" },
		});
	});
});
