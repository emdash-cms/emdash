import { afterEach, describe, it, expect, vi } from "vitest";

import {
	__resetRefreshSingleFlightForTests,
	createRecord,
	ensureSession,
	normalizePdsHost,
	rkeyFromUri,
} from "../src/atproto.js";

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

	it("preserves ports for https URLs", () => {
		expect(normalizePdsHost("https://localhost:2583")).toBe("localhost:2583");
	});

	it("rejects non-https protocols", () => {
		expect(() => normalizePdsHost("http://localhost:2583")).toThrow(
			"Invalid PDS host protocol: http:",
		);
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
			["settings:handle", "example.com"],
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
						handle: "example.com",
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
			{ name: "Example Site" },
		);

		expect(result).toEqual({ uri: "at://did:plc:test/site.standard.publication/abc", cid: "cid" });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(kv.get("state:accessJwt")).toBe("fresh-access");
		expect(kv.get("state:refreshJwt")).toBe("fresh-refresh");
	});
});

describe("ensureSession token-refresh single-flight", () => {
	afterEach(() => {
		__resetRefreshSingleFlightForTests();
		vi.restoreAllMocks();
	});

	function makeCtx(fetch: ReturnType<typeof vi.fn>) {
		// No state:accessJwt -> ensureSession takes the refresh path.
		const kv = new Map<string, unknown>([
			["settings:pdsHost", "bsky.social"],
			["settings:handle", "example.com"],
			["settings:appPassword", "app-password"],
			["state:refreshJwt", "refresh-token"],
			["state:did", "did:plc:test"],
		]);
		const ctx = {
			http: { fetch },
			kv: {
				get: vi.fn(async (key: string) => kv.get(key)),
				set: vi.fn(async (key: string, value: unknown) => {
					kv.set(key, value);
				}),
			},
		} as any;
		return { ctx, kv };
	}

	function freshRefreshResponse(): Response {
		return new Response(
			JSON.stringify({
				accessJwt: "fresh-access",
				refreshJwt: "fresh-refresh",
				did: "did:plc:test",
				handle: "example.com",
			}),
			{ status: 200 },
		);
	}

	it("coalesces concurrent refreshes onto a single PDS call (waiters read KV)", async () => {
		__resetRefreshSingleFlightForTests({ pollMs: 5 });
		let refreshCalls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("refreshSession")) {
				refreshCalls += 1;
				await gate;
				return freshRefreshResponse();
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const { ctx } = makeCtx(fetch);

		const a = ensureSession(ctx);
		const b = ensureSession(ctx);
		// Hold the owner mid-refresh so the second caller parks in the poll
		// loop, then let it finish.
		await new Promise((resolve) => setTimeout(resolve, 30));
		release();
		const [ra, rb] = await Promise.all([a, b]);

		expect(refreshCalls).toBe(1);
		expect(ra.accessJwt).toBe("fresh-access");
		expect(rb.accessJwt).toBe("fresh-access");
	});

	it("a stranded owner (cancelled request) does not hang later refreshers", async () => {
		// Regression for the isolate-poisoning class: the old implementation
		// cached the in-flight refresh *promise*, so a first caller whose
		// request was cancelled mid-refresh left a never-settling promise that
		// every later ensureSession on the isolate awaited forever (524). The
		// lock-and-poll cache must let a later caller reclaim and recover.
		__resetRefreshSingleFlightForTests({ deadlineMs: 80, pollMs: 10, maxWaitMs: 5000 });
		let refreshCalls = 0;
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("refreshSession")) {
				refreshCalls += 1;
				if (refreshCalls === 1) {
					// Owner A's request is cancelled mid-refresh: never settles.
					await new Promise(() => {});
				}
				return freshRefreshResponse();
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const { ctx } = makeCtx(fetch);

		// Owner A claims and strands. Its request is gone; nobody awaits it.
		const stranded = ensureSession(ctx);
		void stranded.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Reader B must reclaim the stale lock and refresh, not hang on A's
		// dead promise.
		const recovered = await ensureSession(ctx);
		expect(recovered.accessJwt).toBe("fresh-access");
		expect(refreshCalls).toBeGreaterThanOrEqual(2);
	});
});
