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
 */

import type { EmDashRequestContext } from "./request-context.js";
import { getRequestContext } from "./request-context.js";

const store = new WeakMap<EmDashRequestContext, Map<string, Promise<unknown>>>();

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

	const promise = fn();
	cache.set(key, promise);
	return promise;
}
