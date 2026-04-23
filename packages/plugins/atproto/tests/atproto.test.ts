import { describe, it, expect, vi } from "vitest";

import { createRecord, normalizePdsHost, rkeyFromUri } from "../src/atproto.js";

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

describe("createRecord", () => {
	it("refreshes the session when the PDS returns a 400 ExpiredToken response", async () => {
		const kv = new Map<string, unknown>([
			["settings:pdsHost", "bsky.social"],
			["settings:handle", "afterword.blog"],
			["settings:appPassword", "app-password"],
			["state:accessJwt", "stale-access"],
			["state:refreshJwt", "refresh-token"],
			["state:did", "did:plc:test"],
		]);
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "ExpiredToken", message: "Token has expired" }), {
					status: 400,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						accessJwt: "fresh-access",
						refreshJwt: "fresh-refresh",
						did: "did:plc:test",
						handle: "afterword.blog",
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ uri: "at://did:plc:test/site.standard.publication/abc", cid: "cid" }),
					{
						status: 200,
					},
				),
			);
		const ctx = {
			http: { fetch },
			kv: {
				get: vi.fn(async (key: string) => kv.get(key)),
				set: vi.fn(async (key: string, value: unknown) => {
					kv.set(key, value);
				}),
			},
		} as any;

		const result = await createRecord(
			ctx,
			"bsky.social",
			"stale-access",
			"did:plc:test",
			"site.standard.publication",
			{ name: "Afterword" },
		);

		expect(result).toEqual({ uri: "at://did:plc:test/site.standard.publication/abc", cid: "cid" });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(kv.get("state:accessJwt")).toBe("fresh-access");
		expect(kv.get("state:refreshJwt")).toBe("fresh-refresh");
	});
});
