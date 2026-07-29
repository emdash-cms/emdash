/**
 * Workers Cache (native Workers Caching) status + purge handlers.
 *
 * Uses `cache.purge()` from `cloudflare:workers` — the same platform API as
 * wrangler `"cache": { "enabled": true }` / Astro `cacheCloudflare()`.
 * No zone ID or Cache Purge API token.
 *
 * Safe when the API is missing (Node, older runtimes, cache not enabled):
 * status reports `configured: false` and purge is a no-op success.
 */

import type { ApiResult } from "../types.js";

export interface WorkersCacheStatus {
	/** Whether native `cache.purge` is available in this runtime. */
	configured: boolean;
}

export interface WorkersCachePurgeResult {
	/** Whether native `cache.purge` was available. */
	configured: boolean;
	/** True when purge ran and reported success. */
	purged: boolean;
}

export interface WorkersCachePurgeApi {
	purge(options: {
		purgeEverything?: boolean;
		tags?: string[];
	}): Promise<{ success?: boolean; errors?: { message?: string }[] } | unknown>;
}

/**
 * Resolve the native Workers Caching purge API.
 * Injected in tests; at runtime loads `cloudflare:workers` when present.
 */
export async function resolveWorkersCachePurgeApi(
	override?: WorkersCachePurgeApi | null,
): Promise<WorkersCachePurgeApi | null> {
	if (override !== undefined) return override;

	try {
		// Dynamic import so core stays loadable on Node / unit tests.
		const mod = await import("cloudflare:workers");
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- optional newer export
		const cache = (mod as { cache?: WorkersCachePurgeApi }).cache;
		if (cache && typeof cache.purge === "function") {
			return {
				purge: (options) => cache.purge(options),
			};
		}
	} catch {
		// Module unavailable outside Workers
	}
	return null;
}

/**
 * Report whether native Workers Cache purge is available.
 */
export async function handleWorkersCacheStatus(
	api?: WorkersCachePurgeApi | null,
): Promise<ApiResult<WorkersCacheStatus>> {
	try {
		const resolved = api === undefined ? await resolveWorkersCachePurgeApi() : api;
		return { success: true, data: { configured: resolved !== null } };
	} catch {
		return {
			success: false,
			error: {
				code: "WORKERS_CACHE_STATUS_ERROR",
				message: "Failed to read Workers Cache status",
			},
		};
	}
}

/**
 * Purge all edge-cached responses for this Worker entrypoint
 * (`purgeEverything: true`).
 */
export async function handleWorkersCachePurge(
	api?: WorkersCachePurgeApi | null,
): Promise<ApiResult<WorkersCachePurgeResult>> {
	try {
		const resolved = api === undefined ? await resolveWorkersCachePurgeApi() : api;

		if (!resolved) {
			return {
				success: true,
				data: { configured: false, purged: false },
			};
		}

		const result = await resolved.purge({ purgeEverything: true });

		if (isPurgeFailure(result)) {
			const detail = formatPurgeErrors(result);
			return {
				success: false,
				error: {
					code: "WORKERS_CACHE_PURGE_ERROR",
					message: detail ? `Workers Cache purge failed: ${detail}` : "Workers Cache purge failed",
				},
			};
		}

		return {
			success: true,
			data: { configured: true, purged: true },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return {
			success: false,
			error: {
				code: "WORKERS_CACHE_PURGE_ERROR",
				message: `Failed to purge Workers Cache: ${message}`,
			},
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPurgeFailure(value: unknown): boolean {
	if (!isRecord(value) || typeof value.success !== "boolean") {
		// Unknown shape — treat as success (older/no-result APIs)
		return false;
	}
	return value.success === false;
}

function formatPurgeErrors(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.errors)) return undefined;
	const messages = value.errors
		.map((error) => {
			if (isRecord(error) && typeof error.message === "string") return error.message;
			return String(error);
		})
		.filter(Boolean);
	return messages.length > 0 ? messages.join("; ") : undefined;
}
