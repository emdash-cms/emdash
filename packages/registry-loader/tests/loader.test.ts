import { describe, expect, it, vi } from "vitest";

import { DEFAULT_REGISTRY_URL, registryLoader } from "../src/index.js";

const CID = `bafyrei${"a".repeat(52)}`;
const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const PROFILE = {
	$type: "com.emdashcms.experimental.package.profile",
	id: `at://${DID}/com.emdashcms.experimental.package.profile/gallery`,
	type: "emdash-plugin",
	license: "MIT",
	authors: [{ name: "Alice", url: "https://alice.example" }],
	security: [{ email: "security@example.com" }],
	name: "Gallery",
	description: "An image gallery.",
	lastUpdated: "2026-09-01T12:00:00Z",
};
const PACKAGE = {
	uri: `at://${DID}/com.emdashcms.experimental.package.profile/gallery`,
	cid: CID,
	did: DID,
	handle: "alice.example.com",
	slug: "gallery",
	indexedAt: "2026-09-01T12:00:00Z",
	latestVersion: "1.0.0",
	profile: PROFILE,
};
const RELEASE = {
	uri: `at://${DID}/com.emdashcms.experimental.package.release/gallery:1.0.0`,
	cid: CID,
	did: DID,
	package: "gallery",
	version: "1.0.0",
	artifactCaches: [],
	indexedAt: "2026-09-01T12:00:00Z",
	release: {
		$type: "com.emdashcms.experimental.package.release",
		package: "gallery",
		version: "1.0.0",
		artifacts: {
			package: { checksum: `bciq${"a".repeat(52)}`, url: "https://example.com/gallery.tgz" },
		},
	},
};

function fetchStub(responses: Record<string, unknown>): typeof fetch {
	return vi.fn(async (input) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const response = responses[url.pathname];
		if (response === undefined) {
			return Response.json({ error: "NotConfigured" }, { status: 500 });
		}
		return Response.json(response);
	});
}

describe("registryLoader", () => {
	it("uses the hosted registry by default", () => {
		expect(DEFAULT_REGISTRY_URL).toBe("https://registry.emdashcms.com");
	});

	it("maps search results to live collection entries", async () => {
		const fetch = fetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.searchPackages": {
				packages: [PACKAGE],
			},
		});
		const loader = registryLoader({ aggregatorUrl: "https://registry.test", fetch });

		const result = await loader.loadCollection({
			collection: "plugins",
			filter: { q: "gallery", capability: "media", limit: 12 },
		});

		expect(result).toMatchObject({
			entries: [
				{
					id: `${DID}/gallery`,
					data: { package: { slug: "gallery", profile: { name: "Gallery" } } },
					cacheHint: { tags: [PACKAGE.uri] },
				},
			],
		});
		const requestUrl = new URL(vi.mocked(fetch).mock.calls[0]![0] as string);
		expect(requestUrl.searchParams.get("q")).toBe("gallery");
		expect(requestUrl.searchParams.get("capability")).toBe("media");
		expect(requestUrl.searchParams.get("limit")).toBe("12");
	});

	it("resolves a handle and includes the latest visible release", async () => {
		const fetch = fetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.resolvePackage": PACKAGE,
			"/xrpc/com.emdashcms.experimental.aggregator.getLatestRelease": RELEASE,
		});
		const loader = registryLoader({ aggregatorUrl: "https://registry.test", fetch });

		const result = await loader.loadEntry({
			collection: "plugins",
			filter: { publisher: "@alice.example.com", slug: "gallery" },
		});

		expect(result).toMatchObject({
			id: `${DID}/gallery`,
			data: {
				package: { did: DID, slug: "gallery" },
				latestRelease: { version: "1.0.0" },
			},
		});
		const urls = vi.mocked(fetch).mock.calls.map((call) => new URL(call[0] as string));
		expect(urls[0]!.searchParams.get("handle")).toBe("alice.example.com");
		expect(urls[1]!.searchParams.get("did")).toBe(DID);
	});

	it("maps unavailable listings to missing entries without exposing remote text", async () => {
		const unsafeText = "publisher-controlled remote error";
		const fetch: typeof globalThis.fetch = vi.fn(async () =>
			Response.json({ error: "ListingUnavailable", message: unsafeText }, { status: 404 }),
		);
		const loader = registryLoader({ aggregatorUrl: "https://registry.test", fetch });

		const result = await loader.loadEntry({
			collection: "plugins",
			filter: { publisher: "alice.example.com", slug: "hidden" },
		});

		expect(result).toBeUndefined();
	});

	it("maps a missing package to a missing live entry", async () => {
		const fetch: typeof globalThis.fetch = vi.fn(async () =>
			Response.json({ error: "NotFound", message: "missing" }, { status: 404 }),
		);
		const loader = registryLoader({ aggregatorUrl: "https://registry.test", fetch });

		await expect(
			loader.loadEntry({
				collection: "plugins",
				filter: { publisher: "alice.example.com", slug: "missing" },
			}),
		).resolves.toBeUndefined();
	});

	it("rejects malformed publisher handles without making a request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const loader = registryLoader({ aggregatorUrl: "https://registry.test", fetch });

		await expect(
			loader.loadEntry({
				collection: "plugins",
				filter: { publisher: "foo..bar", slug: "gallery" },
			}),
		).resolves.toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("loads DID entries from the package endpoint", async () => {
		const fetch = fetchStub({
			"/xrpc/com.emdashcms.experimental.aggregator.getPackage": PACKAGE,
			"/xrpc/com.emdashcms.experimental.aggregator.getLatestRelease": RELEASE,
		});
		const loader = registryLoader({ aggregatorUrl: "https://registry.test", fetch });

		const result = await loader.loadEntry({
			collection: "plugins",
			filter: { publisher: DID, slug: "gallery" },
		});

		expect(result).toMatchObject({ id: `${DID}/gallery` });
		expect(new URL(vi.mocked(fetch).mock.calls[0]![0] as string).pathname).toBe(
			"/xrpc/com.emdashcms.experimental.aggregator.getPackage",
		);
	});
});
