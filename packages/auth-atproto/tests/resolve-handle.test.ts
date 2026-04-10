import { describe, it, expect, vi, afterEach } from "vitest";

import { verifyHandleDID } from "../src/resolve-handle.js";

describe("verifyHandleDID", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("returns null for handles without a dot", async () => {
		expect(await verifyHandleDID("localhost")).toBeNull();
		expect(await verifyHandleDID("")).toBeNull();
	});

	it("returns null when resolution fails", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
		expect(await verifyHandleDID("nobody.example.com")).toBeNull();
	});

	it("returns null when HTTP returns non-ok", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
		expect(await verifyHandleDID("nobody.example.com")).toBeNull();
	});
});
