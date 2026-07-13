import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	ARTIFACT_MAX_BYTES,
	fetchResource,
	PROVENANCE_MAX_BYTES,
	resolveHostname,
} from "../src/index.js";

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const publicAddress = async (): Promise<readonly string[]> => ["203.0.113.5"];

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("release-verifier Worker", () => {
	it("returns bytes across the typed RPC boundary", async () => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "cloudflare-dns.com") {
				const answer =
					url.searchParams.get("type") === "A" ? [{ type: 1, data: "203.0.113.5" }] : [];
				return Response.json({ Status: 0, Answer: answer });
			}
			return new Response(encoder.encode("artifact"));
		});

		const result = await exports.default.fetchArtifact("https://artifact.example.test/plugin.tgz");
		expect(result).toMatchObject({ success: true });
		if (result.success) expect(new TextDecoder().decode(result.value)).toBe("artifact");
	});

	it("revalidates every redirect and returns no response metadata", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://cdn.example.test/plugin.tgz" },
				}),
			)
			.mockResolvedValueOnce(new Response(encoder.encode("bundle")));
		const resolveRedirectHostname = vi.fn(publicAddress);
		const result = await fetchResource("https://origin.example.test/plugin.tgz", 1024, {
			fetch,
			resolveHostname: resolveRedirectHostname,
		});

		expect(result).toEqual({ success: true, value: encoder.encode("bundle") });
		expect(resolveRedirectHostname).toHaveBeenNthCalledWith(1, "origin.example.test");
		expect(resolveRedirectHostname).toHaveBeenNthCalledWith(2, "cdn.example.test");
	});

	it("uses separate bounded limits for artifacts and provenance", async () => {
		expect(ARTIFACT_MAX_BYTES).toBe(384 * 1024);
		// Leave room for the VerificationResult envelope within Workers' 1 MiB RPC limit.
		expect(PROVENANCE_MAX_BYTES).toBe(960 * 1024);
		expect(PROVENANCE_MAX_BYTES).toBeLessThan(1024 * 1024);
		const result = await fetchResource("https://artifact.example.test/plugin.tgz", 3, {
			fetch: async () => new Response(encoder.encode("large")),
			resolveHostname: publicAddress,
		});
		expect(result).toMatchObject({
			success: false,
			error: { code: "RESOURCE_SIZE_EXCEEDED" },
		});
	});

	it("bounds response headers and streamed bodies in workerd", async () => {
		const headers = await fetchResource("https://artifact.example.test/plugin.tgz", 1024, {
			fetch: () => new Promise<Response>(() => {}),
			resolveHostname: publicAddress,
			headerTimeoutMs: 1,
			totalTimeoutMs: 20,
		});
		expect(headers).toMatchObject({ success: false, error: { code: "RESOURCE_TIMEOUT" } });

		let cancelled = false;
		const body = await fetchResource("https://artifact.example.test/plugin.tgz", 1024, {
			fetch: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
			resolveHostname: publicAddress,
			totalTimeoutMs: 1,
		});
		expect(body).toMatchObject({ success: false, error: { code: "RESOURCE_TIMEOUT" } });
		expect(cancelled).toBe(true);
	});

	it("rejects malformed and oversize DNS responses", async () => {
		globalThis.fetch = vi.fn(async () => Response.json({ Status: "zero", Answer: [] }));
		await expect(resolveHostname("artifact.example.test")).rejects.toThrow("Invalid DNS response");

		globalThis.fetch = vi.fn(async () =>
			Response.json(
				{ Status: 0, Answer: [] },
				{ headers: { "content-length": String(64 * 1024 + 1) } },
			),
		);
		await expect(resolveHostname("artifact.example.test")).rejects.toThrow(
			"DNS response exceeds limit",
		);
	});
});
