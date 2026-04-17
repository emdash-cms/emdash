/**
 * Per-request query cache
 *
 * Deduplicates identical database queries within a single page render.
 * Uses the ALS request context as a WeakMap key so the cache is
 * automatically GC'd when the request completes.
 *
 * When no request context is available (e.g. local dev without D1
 * replicas), queries bypass the cache — local SQLite is fast enough
 * that deduplication doesn't matter.
 *
 * The WeakMap is stored on globalThis with a Symbol key to guarantee
 * a singleton even when bundlers duplicate this module across chunks
 * (same pattern as request-context.ts).
 */

import type { EmDashRequestContext } from "./request-context.js";
import { getRequestContext } from "./request-context.js";

type CacheStore = WeakMap<EmDashRequestContext, Map<string, Promise<unknown>>>;

const STORE_KEY = Symbol.for("emdash:request-cache");
const g = globalThis as Record<symbol, unknown>;
const store: CacheStore =
	(g[STORE_KEY] as CacheStore | undefined) ??
	(() => {
		const wm: CacheStore = new WeakMap();
		g[STORE_KEY] = wm;
		return wm;
	})();

/**
 * Return a cached result for `key` if one exists in the current
 * request scope, otherwise call `fn`, cache its promise, and return it.
 *
 * Caches the *promise*, not the resolved value, so concurrent calls
 * with the same key share a single in-flight query.
 */
export function requestCached<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const ctx = getRequestContext();
	if (!ctx) return fn();

	let cache = store.get(ctx);
	if (!cache) {
		cache = new Map();
		store.set(ctx, cache);
	}

	const existing = cache.get(key);
	if (existing) return existing as Promise<T>;

	const promise = Promise.resolve()
		.then(fn)
		.catch((error) => {
			cache.delete(key);
			throw error;
		});
	cache.set(key, promise);
	return promise;
}

/**
 * Pre-populate the request-scoped cache with a resolved value.
 *
 * Intended for hydration paths that already have the data in hand and want
 * downstream callers using `requestCached(key, ...)` to skip the database
 * entirely. No-ops outside a request context (local dev without ALS).
 *
 * Does not overwrite an existing entry — if a query for this key is already
 * in flight, its promise wins.
 */
export function setRequestCacheEntry<T>(key: string, value: T): void {
	const ctx = getRequestContext();
	if (!ctx) return;

	let cache = store.get(ctx);
	if (!cache) {
		cache = new Map();
		store.set(ctx, cache);
	}

	if (cache.has(key)) return;
	cache.set(key, Promise.resolve(value));
}
