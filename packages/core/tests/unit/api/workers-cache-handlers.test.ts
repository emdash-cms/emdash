/**
 * Workers Cache purge handlers (native cache.purge).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	handleWorkersCachePurge,
	handleWorkersCacheStatus,
	normalizeWorkersCachePathPrefix,
	type WorkersCachePurgeApi,
} from "../../../src/api/handlers/workers-cache.js";

describe("normalizeWorkersCachePathPrefix", () => {
	it("normalizes bare paths", () => {
		expect(normalizeWorkersCachePathPrefix("/posts/foo")).toEqual({
			ok: true,
			path: "/posts/foo",
		});
		expect(normalizeWorkersCachePathPrefix("posts/foo")).toEqual({
			ok: true,
			path: "/posts/foo",
		});
	});

	it("strips origin, query, and hash from full URLs", () => {
		expect(normalizeWorkersCachePathPrefix("https://example.com/posts/foo?x=1#hash")).toEqual({
			ok: true,
			path: "/posts/foo",
		});
	});

	it("treats digit-containing schemes as absolute URLs", () => {
		expect(normalizeWorkersCachePathPrefix("s3://bucket/object")).toEqual({
			ok: true,
			path: "/object",
		});
	});

	it("rejects empty input", () => {
		expect(normalizeWorkersCachePathPrefix("   ")).toEqual({
			ok: false,
			message: "Path is required",
		});
	});

	it("rejects protocol-relative URLs", () => {
		expect(normalizeWorkersCachePathPrefix("//example.com/posts")).toEqual({
			ok: false,
			message: "Protocol-relative URLs are not allowed",
		});
	});
});

describe("handleWorkersCacheStatus", () => {
	it("reports configured:false when purge API is null", async () => {
		const result = await handleWorkersCacheStatus(null);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.configured).toBe(false);
	});

	it("reports configured:true when purge API is provided", async () => {
		const api: WorkersCachePurgeApi = {
			purge: vi.fn(),
		};
		const result = await handleWorkersCacheStatus(api);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.configured).toBe(true);
	});
});

describe("handleWorkersCachePurge", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns configured:false without calling purge when API missing", async () => {
		const result = await handleWorkersCachePurge({}, null);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ configured: false, purged: false });
	});

	it("calls purgeEverything when no paths are given", async () => {
		const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
		const result = await handleWorkersCachePurge({}, { purge });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ configured: true, purged: true });
		expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
	});

	it("calls pathPrefixes when paths are given", async () => {
		const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
		const result = await handleWorkersCachePurge(
			{ pathPrefixes: ["https://example.com/posts/a", "/posts/b"] },
			{ purge },
		);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({
			configured: true,
			purged: true,
			pathPrefixes: ["/posts/a", "/posts/b"],
		});
		expect(purge).toHaveBeenCalledWith({ pathPrefixes: ["/posts/a", "/posts/b"] });
	});

	it("rejects invalid path input", async () => {
		const purge = vi.fn();
		const result = await handleWorkersCachePurge({ pathPrefixes: ["   "] }, { purge });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(purge).not.toHaveBeenCalled();
	});

	it("surfaces purge API failure results", async () => {
		const purge = vi.fn().mockResolvedValue({
			success: false,
			errors: [{ message: "rate limited" }],
		});
		const result = await handleWorkersCachePurge({}, { purge });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("WORKERS_CACHE_PURGE_ERROR");
		expect(result.error.message).toContain("rate limited");
	});
});
