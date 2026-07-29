/**
 * Workers Cache purge handlers (native cache.purge).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	handleWorkersCachePurge,
	handleWorkersCacheStatus,
	type WorkersCachePurgeApi,
} from "../../../src/api/handlers/workers-cache.js";

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
		const result = await handleWorkersCachePurge(null);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ configured: false, purged: false });
	});

	it("calls purgeEverything when API is present", async () => {
		const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
		const result = await handleWorkersCachePurge({ purge });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ configured: true, purged: true });
		expect(purge).toHaveBeenCalledOnce();
		expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
	});

	it("surfaces purge API failure results", async () => {
		const purge = vi.fn().mockResolvedValue({
			success: false,
			errors: [{ message: "rate limited" }],
		});
		const result = await handleWorkersCachePurge({ purge });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("WORKERS_CACHE_PURGE_ERROR");
		expect(result.error.message).toContain("rate limited");
	});

	it("surfaces thrown errors", async () => {
		const purge = vi.fn().mockRejectedValue(new Error("boom"));
		const result = await handleWorkersCachePurge({ purge });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("WORKERS_CACHE_PURGE_ERROR");
		expect(result.error.message).toContain("boom");
	});
});
