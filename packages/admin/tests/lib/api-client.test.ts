import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { apiFetch, fetchManifest } from "../../src/lib/api/client";

describe("apiFetch", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		globalThis.fetch = fetchSpy;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("adds X-EmDash-Request header", async () => {
		await apiFetch("/test");
		expect(fetchSpy).toHaveBeenCalledOnce();
		const [, init] = fetchSpy.mock.calls[0]!;
		const headers = new Headers(init.headers);
		expect(headers.get("X-EmDash-Request")).toBe("1");
	});

	it("preserves existing headers", async () => {
		await apiFetch("/test", { headers: { "Content-Type": "application/json" } });
		const [, init] = fetchSpy.mock.calls[0]!;
		const headers = new Headers(init.headers);
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("X-EmDash-Request")).toBe("1");
	});

	it("passes through other init options", async () => {
		await apiFetch("/test", { method: "POST", body: "data" });
		const [, init] = fetchSpy.mock.calls[0]!;
		expect(init.method).toBe("POST");
		expect(init.body).toBe("data");
	});
});

describe("fetchManifest", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns parsed manifest on success", async () => {
		const manifest = {
			version: "1.0",
			collections: {},
			plugins: {},
			authMode: "passkey",
			hash: "abc",
		};
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ data: manifest }), { status: 200 }));
		const result = await fetchManifest();
		expect(result.version).toBe("1.0");
		expect(result.authMode).toBe("passkey");
	});

	it("throws on non-ok response", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 500, statusText: "Internal Server Error" }));
		await expect(fetchManifest()).rejects.toThrow("Failed to fetch manifest");
	});
});
