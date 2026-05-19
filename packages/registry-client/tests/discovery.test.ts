import { ClientResponseError } from "@atcute/client";
import { describe, expect, it, vi } from "vitest";

import { DiscoveryClient } from "../src/discovery/index.js";

/**
 * Builds a fetch stub that records every call and returns canned responses.
 */
function buildFetchStub(responses: Record<string, { status: number; body: unknown }>): {
	fetch: typeof fetch;
	calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetchStub: typeof fetch = vi.fn(async (input, init) => {
		const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init });
		const path = new URL(url).pathname;
		const match = responses[path];
		if (!match) {
			return new Response(JSON.stringify({ error: "TestNotConfigured" }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(match.body), {
			status: match.status,
			headers: { "content-type": "application/json" },
		});
	});
	return { fetch: fetchStub, calls };
}

describe("DiscoveryClient", () => {
	const aggregator = "https://aggregator.test";

	it("hits the searchPackages XRPC endpoint with the right query string", async () => {
		const { fetch, calls } = buildFetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.searchPackages": {
				status: 200,
				body: { packages: [], cursor: undefined },
			},
		});

		const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
		const result = await client.searchPackages({ q: "gallery", limit: 5 });

		expect(result.packages).toEqual([]);
		expect(calls).toHaveLength(1);
		const callUrl = new URL(calls[0]!.url);
		expect(callUrl.pathname).toBe("/xrpc/com.emdashcms.experimental.aggregator.searchPackages");
		expect(callUrl.searchParams.get("q")).toBe("gallery");
		expect(callUrl.searchParams.get("limit")).toBe("5");
	});

	it("forwards the atproto-accept-labelers header when configured", async () => {
		const { fetch, calls } = buildFetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.searchPackages": {
				status: 200,
				body: { packages: [] },
			},
		});

		const client = new DiscoveryClient({
			aggregatorUrl: aggregator,
			acceptLabelers: "did:plc:labeller-a, did:plc:labeller-b",
			fetch,
		});
		await client.searchPackages({ q: "x" });

		const headers = new Headers(calls[0]!.init?.headers);
		expect(headers.get("atproto-accept-labelers")).toBe("did:plc:labeller-a, did:plc:labeller-b");
	});

	it("does not set atproto-accept-labelers when the option is omitted", async () => {
		const { fetch, calls } = buildFetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.searchPackages": {
				status: 200,
				body: { packages: [] },
			},
		});

		const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
		await client.searchPackages({ q: "x" });

		const headers = new Headers(calls[0]!.init?.headers);
		expect(headers.get("atproto-accept-labelers")).toBeNull();
	});

	it("throws ClientResponseError on non-2xx responses with the structured payload", async () => {
		const { fetch } = buildFetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.getPackage": {
				status: 404,
				body: { error: "PackageNotFound", message: "no such package" },
			},
		});

		const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
		try {
			await client.getPackage({ did: "did:plc:xyz", slug: "missing" });
			expect.fail("expected ClientResponseError");
		} catch (err) {
			expect(err).toBeInstanceOf(ClientResponseError);
			const e = err as ClientResponseError;
			expect(e.status).toBe(404);
			expect(e.error).toBe("PackageNotFound");
			expect(e.description).toBe("no such package");
		}
	});

	it("hits each XRPC endpoint at the right path", async () => {
		const { fetch, calls } = buildFetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.getPackage": {
				status: 200,
				body: {
					uri: "at://did:plc:abc/com.emdashcms.experimental.package.profile/gallery",
					cid: "bafy",
					did: "did:plc:abc",
					indexedAt: "2026-04-01T00:00:00Z",
					profile: {},
				},
			},
			"/xrpc/com.emdashcms.experimental.aggregator.resolvePackage": {
				status: 200,
				body: {
					uri: "at://did:plc:abc/com.emdashcms.experimental.package.profile/gallery",
					cid: "bafy",
					did: "did:plc:abc",
					indexedAt: "2026-04-01T00:00:00Z",
					profile: {},
				},
			},
			"/xrpc/com.emdashcms.experimental.aggregator.listReleases": {
				status: 200,
				body: { releases: [], cursor: undefined },
			},
			"/xrpc/com.emdashcms.experimental.aggregator.getLatestRelease": {
				status: 200,
				body: {
					uri: "at://did:plc:abc/com.emdashcms.experimental.package.release/gallery:1.0.0",
					cid: "bafy",
					version: "1.0.0",
					indexedAt: "2026-04-01T00:00:00Z",
					release: {},
				},
			},
		});

		const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });

		await client.getPackage({ did: "did:plc:abc", slug: "gallery" });
		await client.resolvePackage({ handle: "alice.example.com", slug: "gallery" });
		await client.listReleases({ did: "did:plc:abc", package: "gallery" });
		await client.getLatestRelease({ did: "did:plc:abc", package: "gallery" });

		const paths = calls.map((c) => new URL(c.url).pathname);
		expect(paths).toEqual([
			"/xrpc/com.emdashcms.experimental.aggregator.getPackage",
			"/xrpc/com.emdashcms.experimental.aggregator.resolvePackage",
			"/xrpc/com.emdashcms.experimental.aggregator.listReleases",
			"/xrpc/com.emdashcms.experimental.aggregator.getLatestRelease",
		]);
	});

	describe("record validation at the trust boundary", () => {
		const validProfile = {
			$type: "com.emdashcms.experimental.package.profile",
			id: "at://did:plc:abc/com.emdashcms.experimental.package.profile/gallery",
			type: "emdash-plugin",
			license: "MIT",
			authors: [{ name: "Alice", url: "https://alice.example" }],
			security: [{ email: "security@example.com" }],
			name: "Gallery",
			description: "An image gallery.",
			keywords: ["images"],
		};
		const validRelease = {
			$type: "com.emdashcms.experimental.package.release",
			package: "gallery",
			version: "1.0.0",
			artifacts: {
				package: { url: "https://cdn.example/gallery-1.0.0.tgz", checksum: "bciqtest" },
			},
		};

		it("returns the typed record for a conforming profile; extra keys pass through (non-stripping)", async () => {
			const { fetch } = buildFetchStub({
				"/xrpc/com.emdashcms.experimental.aggregator.getPackage": {
					status: 200,
					body: {
						uri: "at://did:plc:abc/com.emdashcms.experimental.package.profile/gallery",
						cid: "bafy",
						did: "did:plc:abc",
						slug: "gallery",
						indexedAt: "2026-04-01T00:00:00Z",
						profile: { ...validProfile, somethingTheAggregatorMadeUp: "ignored" },
					},
				},
			});
			const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
			const result = await client.getPackage({ did: "did:plc:abc", slug: "gallery" });

			expect(result.profile).not.toBeNull();
			expect(result.profile?.name).toBe("Gallery");
			expect(result.profile?.authors?.[0]?.name).toBe("Alice");
			// Contract: atcute validation is non-stripping (the lexicon objects
			// are open). Unrecognised keys are NOT removed — they pass through
			// inert because consumers only read the typed lexicon fields. This
			// asserts the boundary's actual behaviour so a future change to it
			// is a deliberate, visible decision.
			expect(result.profile).toHaveProperty("somethingTheAggregatorMadeUp");
		});

		it("returns null for a profile that does not conform to the lexicon", async () => {
			const { fetch } = buildFetchStub({
				"/xrpc/com.emdashcms.experimental.aggregator.getPackage": {
					status: 200,
					body: {
						uri: "at://did:plc:abc/com.emdashcms.experimental.package.profile/x",
						cid: "bafy",
						did: "did:plc:abc",
						slug: "x",
						indexedAt: "2026-04-01T00:00:00Z",
						// Missing every required field (id/type/license/authors/security).
						profile: { name: "Looks fine but isn't" },
					},
				},
			});
			const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
			const result = await client.getPackage({ did: "did:plc:abc", slug: "x" });
			expect(result.profile).toBeNull();
		});

		it("returns null for a non-conforming release (fail closed)", async () => {
			const { fetch } = buildFetchStub({
				"/xrpc/com.emdashcms.experimental.aggregator.getLatestRelease": {
					status: 200,
					body: {
						uri: "at://did:plc:abc/com.emdashcms.experimental.package.release/x:1.0.0",
						cid: "bafy",
						version: "1.0.0",
						indexedAt: "2026-04-01T00:00:00Z",
						release: "not even an object",
					},
				},
			});
			const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
			const result = await client.getLatestRelease({ did: "did:plc:abc", package: "x" });
			expect(result.release).toBeNull();
		});

		it("does NOT sanitise URL schemes — a javascript: author url passes lexicon validation", async () => {
			// Documents the boundary's contract: it validates *structure*, not
			// URL safety (atproto's `uri` format permits any scheme). Consumers
			// rendering these URLs MUST apply their own scheme allow-list.
			const { fetch } = buildFetchStub({
				"/xrpc/com.emdashcms.experimental.aggregator.getPackage": {
					status: 200,
					body: {
						uri: "at://did:plc:abc/com.emdashcms.experimental.package.profile/gallery",
						cid: "bafy",
						did: "did:plc:abc",
						slug: "gallery",
						indexedAt: "2026-04-01T00:00:00Z",
						profile: {
							...validProfile,
							authors: [{ name: "Mallory", url: "javascript:alert(document.cookie)" }],
						},
					},
				},
			});
			const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
			const result = await client.getPackage({ did: "did:plc:abc", slug: "gallery" });
			expect(result.profile).not.toBeNull();
			expect(result.profile?.authors?.[0]?.url).toBe("javascript:alert(document.cookie)");
		});

		it("validates each release in a listReleases page", async () => {
			const { fetch } = buildFetchStub({
				"/xrpc/com.emdashcms.experimental.aggregator.listReleases": {
					status: 200,
					body: {
						releases: [
							{
								uri: "at://did:plc:abc/com.emdashcms.experimental.package.release/gallery:1.0.0",
								cid: "bafy",
								did: "did:plc:abc",
								package: "gallery",
								version: "1.0.0",
								indexedAt: "2026-04-01T00:00:00Z",
								release: validRelease,
							},
							{
								uri: "at://did:plc:abc/com.emdashcms.experimental.package.release/gallery:0.9.0",
								cid: "bafz",
								did: "did:plc:abc",
								package: "gallery",
								version: "0.9.0",
								indexedAt: "2026-03-01T00:00:00Z",
								release: { garbage: true },
							},
						],
						cursor: undefined,
					},
				},
			});
			const client = new DiscoveryClient({ aggregatorUrl: aggregator, fetch });
			const result = await client.listReleases({ did: "did:plc:abc", package: "gallery" });
			expect(result.releases[0]?.release?.version).toBe("1.0.0");
			expect(result.releases[1]?.release).toBeNull();
		});
	});
});
