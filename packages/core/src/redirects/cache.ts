/**
 * Redirect rule cache.
 *
 * Worker-isolate cache for enabled redirect rules. The middleware populates
 * this on first request; route handlers invalidate it on writes. Cached rules
 * expire so writes handled by another isolate become visible here too.
 *
 * Both exact-match and pattern rules are loaded from one query and cached
 * together: exact rules indexed by source path in a Map, pattern rules
 * pre-compiled into an array. A single warm request issues zero database
 * queries; a cold or expired isolate issues one.
 *
 * This module deliberately has NO Astro imports so it can be safely imported
 * from handlers, seed, CLI, and tests without dragging in `astro:middleware`.
 */

import { after } from "../after.js";
import type { Redirect } from "../database/repositories/redirect.js";
import {
	createSingleFlightCache,
	type SingleFlightCache,
	invalidateSingleFlightCache,
	singleFlightCached,
} from "../utils/single-flight-cache.js";
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

interface RedirectCacheState {
	redirects: CachedRedirects | null;
	expiresAt: number;
	generation: number;
	refresh: SingleFlightCache<CachedRedirects>;
}

const REDIRECT_CACHE_TTL_MS = 30_000;
const REDIRECT_CACHE_MAX_REFRESH_ATTEMPTS = 3;
const REDIRECT_CACHE_KEY = Symbol.for("emdash:redirect-cache");
const g = globalThis as Record<symbol, unknown>;
const cacheState: RedirectCacheState =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-context.ts)
	(g[REDIRECT_CACHE_KEY] as RedirectCacheState | undefined) ??
	(() => {
		const state: RedirectCacheState = {
			redirects: null,
			expiresAt: 0,
			generation: 0,
			refresh: createSingleFlightCache<CachedRedirects>(),
		};
		g[REDIRECT_CACHE_KEY] = state;
		return state;
	})();

/**
 * Invalidate the cached redirects (both exact and pattern).
 * Call when redirects are created, updated, or deleted.
 */
export function invalidateRedirectCache(): void {
	cacheState.generation++;
	cacheState.redirects = null;
	cacheState.expiresAt = 0;
	invalidateSingleFlightCache(cacheState.refresh);
}

/**
 * Get the cached redirects, or null if the cache is cold.
 */
function getCachedRedirects(): CachedRedirects | null {
	if (cacheState.redirects && Date.now() >= cacheState.expiresAt) {
		invalidateRedirectCache();
	}
	return cacheState.redirects;
}

/** Compile enabled database rows into the in-memory lookup structures. */
function compileRedirects(redirects: Redirect[]): CachedRedirects {
	const exact = new Map<string, Redirect>();
	const patterns: CachedRedirectRule[] = [];
	for (const r of redirects) {
		if (r.isPattern) {
			patterns.push({ redirect: r, compiled: compilePattern(r.source) });
		} else {
			exact.set(r.source, r);
		}
	}
	return { exact, patterns };
}

function installCachedRedirects(redirects: CachedRedirects): CachedRedirects {
	cacheState.redirects = redirects;
	cacheState.expiresAt = Date.now() + REDIRECT_CACHE_TTL_MS;
	return cacheState.redirects;
}

export async function loadCachedRedirects(
	load: () => Promise<Redirect[]>,
): Promise<CachedRedirects> {
	for (let attempt = 0; attempt < REDIRECT_CACHE_MAX_REFRESH_ATTEMPTS; attempt++) {
		const cached = getCachedRedirects();
		if (cached) return cached;

		const generation = cacheState.generation;
		const loaded = await singleFlightCached(
			cacheState.refresh,
			async () => compileRedirects(await load()),
			{ anchor: (promise) => after(() => promise), ownerTimeoutMs: 30_000 },
		);

		if (generation === cacheState.generation) {
			return installCachedRedirects(loaded);
		}

		if (attempt === REDIRECT_CACHE_MAX_REFRESH_ATTEMPTS - 1) {
			return loaded;
		}
	}

	throw new Error("Redirect cache refresh exhausted without loading rules");
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
