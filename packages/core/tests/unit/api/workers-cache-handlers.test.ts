/**
 * Workers Cache purge handlers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	handleWorkersCachePurge,
	handleWorkersCacheStatus,
} from "../../../src/api/handlers/workers-cache.js";

describe("handleWorkersCacheStatus", () => {
	it("reports configured:false when credentials are null", async () => {
		const result = await handleWorkersCacheStatus(null);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.configured).toBe(false);
	});

	it("reports configured:true when credentials are provided", async () => {
		const result = await handleWorkersCacheStatus({
			zoneId: "zone-1",
			apiToken: "token-1",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.configured).toBe(true);
	});
});

describe("handleWorkersCachePurge", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns configured:false without calling Cloudflare when credentials missing", async () => {
		const fetchImpl = vi.fn();
		const result = await handleWorkersCachePurge(null, fetchImpl as typeof fetch);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ configured: false, purged: false });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("posts purge_everything when credentials are present", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
		const result = await handleWorkersCachePurge(
			{ zoneId: "zone-abc", apiToken: "tok-xyz" },
			fetchImpl as typeof fetch,
		);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ configured: true, purged: true });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone-abc/purge_cache");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer tok-xyz",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init.body))).toEqual({ purge_everything: true });
	});

	it("surfaces Cloudflare API errors", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
		const result = await handleWorkersCachePurge(
			{ zoneId: "zone-abc", apiToken: "tok-xyz" },
			fetchImpl as typeof fetch,
		);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("WORKERS_CACHE_PURGE_ERROR");
		expect(result.error.message).toContain("403");
	});
});
