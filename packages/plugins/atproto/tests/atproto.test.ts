import { describe, it, expect } from "vitest";

import { normalizePdsHost, rkeyFromUri } from "../src/atproto.js";

describe("normalizePdsHost", () => {
	it("defaults to bsky.social", () => {
		expect(normalizePdsHost(undefined)).toBe("bsky.social");
	});

	it("accepts host-only values", () => {
		expect(normalizePdsHost("bsky.social")).toBe("bsky.social");
	});

	it("accepts full PDS URLs", () => {
		expect(normalizePdsHost("https://bsky.social")).toBe("bsky.social");
		expect(normalizePdsHost("https://example.com/")).toBe("example.com");
	});

	it("preserves ports", () => {
		expect(normalizePdsHost("http://localhost:2583")).toBe("localhost:2583");
	});
});

describe("rkeyFromUri", () => {
	it("extracts rkey from a standard AT-URI", () => {
		const rkey = rkeyFromUri("at://did:plc:abc123/site.standard.document/3lwafzkjqm25s");
		expect(rkey).toBe("3lwafzkjqm25s");
	});

	it("extracts rkey from a Bluesky post URI", () => {
		const rkey = rkeyFromUri("at://did:plc:abc123/app.bsky.feed.post/3k4duaz5vfs2b");
		expect(rkey).toBe("3k4duaz5vfs2b");
	});

	it("throws on empty URI", () => {
		expect(() => rkeyFromUri("")).toThrow("Invalid AT-URI");
	});
});
