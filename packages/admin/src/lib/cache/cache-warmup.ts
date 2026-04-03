/**
 * Cache warmup -- pre-loads critical singletons from IndexedDB on app startup.
 *
 * This runs before React renders so that the manifest and currentUser
 * are available synchronously as placeholderData on the first render,
 * eliminating the loading spinner on repeat visits.
 */

import { getCached } from "./cache-store.js";
import { isIDBAvailable } from "./db.js";

export interface WarmupData {
	singletons: Map<string, unknown>;
}

/** Singleton keys to pre-load during warmup */
const WARMUP_KEYS = ["manifest", "currentUser"] as const;

/**
 * Load critical cached data from IndexedDB. Returns a map of
 * singleton key -> cached value. Runs once on app startup.
 */
export async function warmupCache(): Promise<WarmupData> {
	const singletons = new Map<string, unknown>();

	if (!isIDBAvailable()) return { singletons };

	try {
		const results = await Promise.allSettled(
			WARMUP_KEYS.map(async (key) => {
				const data = await getCached("singletons", key);
				if (data !== undefined) {
					singletons.set(key, data);
				}
			}),
		);

		// Log any warmup failures in dev
		for (const result of results) {
			if (result.status === "rejected") {
				console.warn("[emdash-cache] warmup error:", result.reason);
			}
		}
	} catch {
		// Warmup failure is non-fatal
	}

	return { singletons };
}
