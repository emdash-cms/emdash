/**
 * In-isolate memory object-cache backend — RUNTIME ENTRY
 *
 * The default backend for the Node runtime and a sensible local-dev option.
 * Caches across requests within a single isolate/process; it is NOT shared
 * across isolates, so on a multi-isolate platform (Cloudflare) you want the KV
 * backend instead. Still useful on Node, where one long-lived process serves
 * every request.
 *
 * Wire it up with `memoryCache()` from `emdash`:
 *
 * ```ts
 * import { memoryCache } from "emdash";
 * emdash({ objectCache: memoryCache() });
 * ```
 *
 * The store lives on `globalThis` behind a `Symbol.for` key so Vite SSR chunk
 * duplication doesn't create two independent caches (same pattern as
 * `request-context.ts`).
 */

import type { CreateObjectCacheBackendFn, ObjectCacheBackend } from "./types.js";

interface Entry {
	value: string;
	/** Absolute expiry in ms (`Date.now()` epoch), or `null` for none. */
	expiresAt: number | null;
}

interface MemoryStore {
	map: Map<string, Entry>;
	maxEntries: number;
}

const STORE_KEY = Symbol.for("emdash:object-cache:memory");
const g = globalThis as Record<symbol, unknown>;

function getStore(maxEntries: number): MemoryStore {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-context.ts)
	const existing = g[STORE_KEY] as MemoryStore | undefined;
	if (existing) {
		// First descriptor wins for sizing; later calls reuse the same map.
		return existing;
	}
	const store: MemoryStore = { map: new Map(), maxEntries };
	g[STORE_KEY] = store;
	return store;
}

/**
 * Create the in-isolate memory backend.
 *
 * Config keys (all optional):
 * - `maxEntries` — soft cap on stored keys; oldest insertions are evicted
 *   first when exceeded (FIFO, cheap and good enough for a backstop). Default
 *   1000.
 */
export const createObjectCache: CreateObjectCacheBackendFn = (config): ObjectCacheBackend => {
	const maxEntries = typeof config.maxEntries === "number" ? config.maxEntries : 1000;
	const store = getStore(maxEntries);

	return {
		get(key: string): Promise<string | null> {
			const entry = store.map.get(key);
			if (!entry) return Promise.resolve(null);
			if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
				store.map.delete(key);
				return Promise.resolve(null);
			}
			return Promise.resolve(entry.value);
		},
		set(key: string, value: string, ttlSeconds?: number): Promise<void> {
			// Refresh insertion order so recently-written keys survive eviction.
			store.map.delete(key);
			store.map.set(key, {
				value,
				expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
			});
			while (store.map.size > store.maxEntries) {
				const oldest = store.map.keys().next().value;
				if (oldest === undefined) break;
				store.map.delete(oldest);
			}
			return Promise.resolve();
		},
		delete(key: string): Promise<void> {
			store.map.delete(key);
			return Promise.resolve();
		},
	};
};
