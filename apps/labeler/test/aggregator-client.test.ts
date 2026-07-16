import { describe, expect, it } from "vitest";

import { AggregatorClient } from "../src/aggregator-client.js";

/** Records every URL the client fetches and returns a caller-supplied
 * Response (or throws, to simulate a transport failure). */
function mockFetcher(handler: (url: string) => Response) {
	const urls: string[] = [];
	const fetcher = {
		fetch: (input: string) => {
			urls.push(input);
			return Promise.resolve(handler(input));
		},
	} as unknown as Fetcher;
	return { fetcher, urls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function notFoundResponse(): Response {
	return jsonResponse({ error: "NotFound", message: "No package indexed." }, 404);
}

const BASE = "https://aggregator/xrpc";

const PACKAGE_VIEW = {
	uri: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/my-plugin",
	cid: "bafyreib2rxk3rybk3examplecidvalue",
	did: "did:plc:abc123",
	slug: "my-plugin",
	profile: {
		$type: "com.emdashcms.experimental.package.profile",
		id: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/my-plugin",
		type: "plugin",
		license: "MIT",
		authors: [{ name: "Ada", handle: "ada.example" }],
		security: [{ contact: "security@example.test" }],
		slug: "my-plugin",
	},
	indexedAt: "2026-07-01T00:00:00.000Z",
	labels: [],
	latestVersion: "1.2.0",
};

const RELEASE_VIEW = {
	uri: "at://did:plc:abc123/com.emdashcms.experimental.package.release/1.2.0",
	cid: "bafyreirelease123examplecidvalue",
	did: "did:plc:abc123",
	package: "my-plugin",
	version: "1.2.0",
	release: {
		$type: "com.emdashcms.experimental.package.release",
		package: "my-plugin",
		version: "1.2.0",
		artifacts: {
			tarball: {
				url: "https://cdn.example/my-plugin-1.2.0.tgz",
				checksum: "sha256-0123456789abcdef",
			},
		},
	},
	mirrors: [],
	indexedAt: "2026-07-01T00:00:00.000Z",
	labels: [],
};

describe("AggregatorClient.getPackage", () => {
	it("builds the getPackage URL with URL-encoded params and parses the view", async () => {
		const { fetcher, urls } = mockFetcher(() => jsonResponse(PACKAGE_VIEW));
		const view = await new AggregatorClient(fetcher).getPackage("did:plc:abc123", "my-plugin");

		expect(urls).toEqual([
			`${BASE}/com.emdashcms.experimental.aggregator.getPackage?did=did%3Aplc%3Aabc123&slug=my-plugin`,
		]);
		expect(view).toEqual(PACKAGE_VIEW);
	});

	it("returns null on a NotFound (404) error", async () => {
		const { fetcher } = mockFetcher(() => notFoundResponse());
		const view = await new AggregatorClient(fetcher).getPackage("did:plc:abc123", "missing");
		expect(view).toBeNull();
	});

	it("throws on a 5xx response", async () => {
		const { fetcher } = mockFetcher(() => new Response("upstream boom", { status: 500 }));
		await expect(
			new AggregatorClient(fetcher).getPackage("did:plc:abc123", "my-plugin"),
		).rejects.toThrow(/getPackage failed: 500/);
	});

	it("throws when the binding fetch rejects (transport failure)", async () => {
		const fetcher = {
			fetch: () => Promise.reject(new Error("binding unreachable")),
		} as unknown as Fetcher;
		await expect(
			new AggregatorClient(fetcher).getPackage("did:plc:abc123", "my-plugin"),
		).rejects.toThrow("binding unreachable");
	});
});

describe("AggregatorClient.getLatestRelease", () => {
	it("builds the getLatestRelease URL with a `package` param and parses the view", async () => {
		const { fetcher, urls } = mockFetcher(() => jsonResponse(RELEASE_VIEW));
		const view = await new AggregatorClient(fetcher).getLatestRelease(
			"did:plc:abc123",
			"my-plugin",
		);

		expect(urls).toEqual([
			`${BASE}/com.emdashcms.experimental.aggregator.getLatestRelease?did=did%3Aplc%3Aabc123&package=my-plugin`,
		]);
		expect(view).toEqual(RELEASE_VIEW);
	});

	it("returns null on a NotFound (404) error", async () => {
		const { fetcher } = mockFetcher(() => notFoundResponse());
		const view = await new AggregatorClient(fetcher).getLatestRelease("did:plc:abc123", "missing");
		expect(view).toBeNull();
	});
});

describe("AggregatorClient.listReleases", () => {
	it("omits the cursor param when none is given and parses the page", async () => {
		const page = { releases: [RELEASE_VIEW], cursor: "next-page-cursor" };
		const { fetcher, urls } = mockFetcher(() => jsonResponse(page));
		const result = await new AggregatorClient(fetcher).listReleases("did:plc:abc123", "my-plugin");

		expect(urls).toEqual([
			`${BASE}/com.emdashcms.experimental.aggregator.listReleases?did=did%3Aplc%3Aabc123&package=my-plugin`,
		]);
		expect(result).toEqual(page);
	});

	it("appends a URL-encoded cursor param when given", async () => {
		const { fetcher, urls } = mockFetcher(() => jsonResponse({ releases: [] }));
		await new AggregatorClient(fetcher).listReleases("did:plc:abc123", "my-plugin", "abc==");

		expect(urls).toEqual([
			`${BASE}/com.emdashcms.experimental.aggregator.listReleases?did=did%3Aplc%3Aabc123&package=my-plugin&cursor=abc%3D%3D`,
		]);
	});

	it("returns null when the parent package is NotFound", async () => {
		const { fetcher } = mockFetcher(() => notFoundResponse());
		const result = await new AggregatorClient(fetcher).listReleases("did:plc:abc123", "missing");
		expect(result).toBeNull();
	});
});

describe("AggregatorClient param encoding", () => {
	it("percent-encodes reserved characters so they cannot alter the query", async () => {
		const { fetcher, urls } = mockFetcher(() => jsonResponse(PACKAGE_VIEW));
		await new AggregatorClient(fetcher).getPackage("did:plc:a&b c", "s/l&ug");

		expect(urls).toEqual([
			`${BASE}/com.emdashcms.experimental.aggregator.getPackage?did=did%3Aplc%3Aa%26b%20c&slug=s%2Fl%26ug`,
		]);
	});
});
