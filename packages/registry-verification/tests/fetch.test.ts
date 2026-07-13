import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchVerifiedResource } from "../src/index.js";

const encoder = new TextEncoder();
const resolvePublicHostname = async (): Promise<readonly string[]> => ["203.0.113.5"];

afterEach(() => {
	vi.useRealTimers();
});

function bytesResponse(value: string, init?: ResponseInit): Response {
	return new Response(encoder.encode(value), init);
}

function streamingResponse(chunks: string[]): Response {
	let index = 0;
	return new Response(
		new ReadableStream({
			pull(controller) {
				const chunk = chunks[index++];
				if (chunk === undefined) controller.close();
				else controller.enqueue(encoder.encode(chunk));
			},
		}),
	);
}

describe("fetchVerifiedResource", () => {
	it("rejects non-HTTPS, malformed, and credential-bearing URLs before fetching", async () => {
		const fetch = vi.fn();
		for (const value of ["http://example.com", "https://user:pass@example.com", "not a URL"]) {
			const result = await fetchVerifiedResource(value, {
				fetch,
				resolveHostname: resolvePublicHostname,
			});
			expect(result).toMatchObject({ success: false, error: { code: "INVALID_URL" } });
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("follows validated redirects and validates every hostname hop", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://cdn.example.test/artifact" },
				}),
			)
			.mockResolvedValueOnce(bytesResponse("artifact"));
		const resolveHostname = vi.fn().mockResolvedValue(["203.0.113.5"]);
		const result = await fetchVerifiedResource("https://origin.example.test/start", {
			fetch,
			resolveHostname,
		});
		expect(result).toMatchObject({
			success: true,
			value: { url: expect.objectContaining({ hostname: "cdn.example.test" }) },
		});
		expect(resolveHostname).toHaveBeenNthCalledWith(1, "origin.example.test");
		expect(resolveHostname).toHaveBeenNthCalledWith(2, "cdn.example.test");
		expect(fetch).toHaveBeenNthCalledWith(
			1,
			expect.any(URL),
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("enforces the redirect limit", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(null, { status: 302, headers: { location: "https://example.test/again" } }),
			);
		const result = await fetchVerifiedResource("https://example.test/start", {
			fetch,
			resolveHostname: resolvePublicHostname,
			maxRedirects: 1,
		});
		expect(result).toMatchObject({ success: false, error: { code: "REDIRECT_LIMIT_EXCEEDED" } });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects a redirect target that resolves to a forbidden address", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "https://private.example.test/artifact" },
			}),
		);
		const resolveHostname = vi.fn(async (hostname: string) =>
			hostname === "private.example.test" ? ["127.0.0.1"] : ["203.0.113.5"],
		);
		const result = await fetchVerifiedResource("https://origin.example.test/start", {
			fetch,
			resolveHostname,
		});
		expect(result).toMatchObject({ success: false, error: { code: "HOST_REJECTED" } });
		expect(resolveHostname).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("re-resolves the same hostname after a redirect", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "/again" },
			}),
		);
		const resolveHostname = vi
			.fn()
			.mockResolvedValueOnce(["203.0.113.5"])
			.mockResolvedValueOnce(["10.0.0.1"]);
		const result = await fetchVerifiedResource("https://artifact.example.test/start", {
			fetch,
			resolveHostname,
		});
		expect(result).toMatchObject({ success: false, error: { code: "HOST_REJECTED" } });
		expect(resolveHostname).toHaveBeenNthCalledWith(1, "artifact.example.test");
		expect(resolveHostname).toHaveBeenNthCalledWith(2, "artifact.example.test");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects oversize content-length and streaming bodies", async () => {
		const contentLength = await fetchVerifiedResource("https://example.test/file", {
			fetch: vi
				.fn()
				.mockResolvedValue(bytesResponse("small", { headers: { "content-length": "6" } })),
			maxBytes: 5,
			resolveHostname: resolvePublicHostname,
		});
		expect(contentLength).toMatchObject({
			success: false,
			error: { code: "RESOURCE_SIZE_EXCEEDED" },
		});

		const streamed = await fetchVerifiedResource("https://example.test/file", {
			fetch: vi.fn().mockResolvedValue(streamingResponse(["abc", "def"])),
			maxBytes: 5,
			resolveHostname: resolvePublicHostname,
		});
		expect(streamed).toMatchObject({ success: false, error: { code: "RESOURCE_SIZE_EXCEEDED" } });
	});

	it("maps fetch failures, statuses, and header timeouts to stable errors", async () => {
		const failed = await fetchVerifiedResource("https://example.test/file", {
			fetch: vi.fn().mockRejectedValue(new Error("network unavailable")),
			resolveHostname: resolvePublicHostname,
		});
		expect(failed).toMatchObject({ success: false, error: { code: "FETCH_FAILED" } });

		const status = await fetchVerifiedResource("https://example.test/file", {
			fetch: vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
			resolveHostname: resolvePublicHostname,
		});
		expect(status).toMatchObject({ success: false, error: { code: "RESOURCE_STATUS_ERROR" } });

		let signal: AbortSignal | undefined;
		const timeout = await fetchVerifiedResource("https://example.test/file", {
			fetch: vi.fn((_, init) => {
				signal = init.signal ?? undefined;
				return new Promise<Response>(() => {});
			}),
			resolveHostname: resolvePublicHostname,
			headerTimeoutMs: 1,
		});
		expect(timeout).toMatchObject({ success: false, error: { code: "RESOURCE_TIMEOUT" } });
		expect(signal?.aborted).toBe(true);
	});

	it("cancels a stalled stream when the total timeout expires", async () => {
		vi.useFakeTimers();
		try {
			let cancelled = false;
			let markReadStarted!: () => void;
			const readStarted = new Promise<void>((resolve) => {
				markReadStarted = resolve;
			});
			const response = new Response(
				new ReadableStream(
					{
						pull() {
							markReadStarted();
							return new Promise<void>(() => {});
						},
						cancel() {
							cancelled = true;
						},
					},
					{ highWaterMark: 0 },
				),
			);
			const fetch = vi.fn().mockResolvedValue(response);
			const resultPromise = fetchVerifiedResource("https://example.test/file", {
				fetch,
				resolveHostname: resolvePublicHostname,
				totalTimeoutMs: 100,
			});

			await readStarted;
			expect(fetch).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(100);

			const result = await resultPromise;
			expect(result).toMatchObject({ success: false, error: { code: "RESOURCE_TIMEOUT" } });
			expect(cancelled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("maps resolver rejection to a stable error before fetching", async () => {
		const fetch = vi.fn();
		for (const address of ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "not-an-address"]) {
			const result = await fetchVerifiedResource("https://example.test/file", {
				fetch,
				resolveHostname: vi.fn().mockResolvedValue([address]),
			});
			expect(result).toMatchObject({ success: false, error: { code: "HOST_REJECTED" } });
		}
		const rejected = await fetchVerifiedResource("https://example.test/file", {
			fetch,
			resolveHostname: vi.fn().mockRejectedValue(new Error("DNS failure")),
		});
		expect(rejected).toMatchObject({ success: false, error: { code: "HOST_REJECTED" } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("bounds a stalled resolver with the total timeout before fetching", async () => {
		const fetch = vi.fn();
		const result = await fetchVerifiedResource("https://example.test/file", {
			fetch,
			resolveHostname: () => new Promise<readonly string[]>(() => {}),
			totalTimeoutMs: 1,
		});
		expect(result).toMatchObject({ success: false, error: { code: "RESOURCE_TIMEOUT" } });
		expect(fetch).not.toHaveBeenCalled();
	});
});
