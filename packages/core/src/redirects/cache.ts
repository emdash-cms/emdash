/**
 * Redirect pattern cache.
 *
 * Module-level cache for compiled redirect pattern rules. The middleware
 * populates this on first request; route handlers invalidate it on writes.
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

/**
 * Cached pattern rules with compiled regexes.
 * null = not yet populated, array = cached.
 */
let cachedPatternRules: CachedRedirectRule[] | null = null;

/**
 * Invalidate the cached redirect pattern rules.
 * Call when redirects are created, updated, or deleted.
 */
export function invalidateRedirectCache(): void {
	cachedPatternRules = null;
}

/**
 * Get the cached compiled pattern rules, or null if the cache is cold.
 */
export function getCachedPatternRules(): CachedRedirectRule[] | null {
	return cachedPatternRules;
}

/**
 * Populate the pattern rules cache from a list of enabled pattern redirects.
 */
export function setCachedPatternRules(redirects: Redirect[]): CachedRedirectRule[] {
	cachedPatternRules = redirects.map((r) => ({
		redirect: r,
		compiled: compilePattern(r.source),
	}));
	return cachedPatternRules;
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
