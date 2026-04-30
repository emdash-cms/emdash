/**
 * Redirect rule cache.
 *
 * Module-level cache for enabled redirect rules. The middleware populates this
 * on first request; route handlers invalidate it on writes.
 *
 * Both exact-match and pattern rules are loaded from one query and cached
 * together: exact rules indexed by source path in a Map, pattern rules
 * pre-compiled into an array. A single warm request issues zero database
 * queries; a cold isolate issues one.
 *
 * This module deliberately has NO Astro imports so it can be safely imported
 * from handlers, seed, CLI, and tests without dragging in `astro:middleware`.
 */

import type { Redirect } from "../database/repositories/redirect.js";
import type { CompiledPattern } from "./patterns.js";
import { compilePattern, interpolateDestination, matchPattern } from "./patterns.js";

export interface CachedRedirectRule {
	redirect: Redirect;
	compiled: CompiledPattern;
}

export interface CachedRedirects {
	/** Exact-match rules indexed by source path (`source` -> `Redirect`). */
	exact: Map<string, Redirect>;
	/** Pattern rules with their compiled regexes, preserving insertion order. */
	patterns: CachedRedirectRule[];
}

/**
 * Cached enabled redirects.
 * null = not yet populated, object = cached.
 */
let cachedRedirects: CachedRedirects | null = null;

/**
 * Invalidate the cached redirects (both exact and pattern).
 * Call when redirects are created, updated, or deleted.
 */
export function invalidateRedirectCache(): void {
	cachedRedirects = null;
}

/**
 * Get the cached redirects, or null if the cache is cold.
 */
export function getCachedRedirects(): CachedRedirects | null {
	return cachedRedirects;
}

/**
 * Populate the cache from a list of enabled redirects (both exact and
 * pattern). The caller is responsible for passing only enabled rows — the
 * cache stores them as-is.
 */
export function setCachedRedirects(redirects: Redirect[]): CachedRedirects {
	const exact = new Map<string, Redirect>();
	const patterns: CachedRedirectRule[] = [];
	for (const r of redirects) {
		if (r.isPattern) {
			patterns.push({ redirect: r, compiled: compilePattern(r.source) });
		} else {
			exact.set(r.source, r);
		}
	}
	cachedRedirects = { exact, patterns };
	return cachedRedirects;
}

/**
 * Match a path against the cached pattern rules.
 * Returns the resolved destination and matching redirect, or null.
 */
export function matchCachedPatterns(
	rules: CachedRedirectRule[],
	pathname: string,
): { redirect: Redirect; destination: string } | null {
	for (const { redirect, compiled } of rules) {
		const params = matchPattern(compiled, pathname);
		if (params) {
			const dest = interpolateDestination(redirect.destination, params);
			return { redirect, destination: dest };
		}
	}
	return null;
}
