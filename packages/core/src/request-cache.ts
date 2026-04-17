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

const STORE_KEY = Symbol.for("emdash:request-cache");

const store: WeakMap<
	EmDashRequestContext,
	Map<string, Promise<unknown>>
> = // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern
((globalThis as Record<symbol, unknown>)[STORE_KEY] as
	| WeakMap<EmDashRequestContext, Map<string, Promise<unknown>>>
	| undefined) ??
(() => {
	const wm = new WeakMap<EmDashRequestContext, Map<string, Promise<unknown>>>();
	(globalThis as Record<symbol, unknown>)[STORE_KEY] = wm;
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
