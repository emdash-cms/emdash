/**
 * Redirect middleware
 *
 * Intercepts incoming requests and checks for matching redirect rules.
 * Runs after runtime init (needs db) but before setup/auth (should handle
 * ALL routes, including public ones, and should be fast).
 *
 * Skip paths:
 * - /_emdash/* (admin UI, API routes, auth endpoints)
 * - /_image (Astro image optimization)
 * - Static assets (files with extensions)
 *
 * 404 logging happens post-response: if next() returns 404 and the path
 * wasn't already matched by a redirect, log it.
 */

import { defineMiddleware } from "astro:middleware";

import type { Redirect } from "../../database/repositories/redirect.js";
import { RedirectRepository } from "../../database/repositories/redirect.js";
import type { CompiledPattern } from "../../redirects/patterns.js";
import { compilePattern, interpolateDestination, matchPattern } from "../../redirects/patterns.js";

/** Paths that should never be intercepted by redirects */
const SKIP_PREFIXES = ["/_emdash", "/_image"];

/**
 * Cached pattern rules with compiled regexes.
 * Invalidated when redirects are created, updated, or deleted.
 */
let cachedPatternRules: Array<{ redirect: Redirect; compiled: CompiledPattern }> | null = null;

/**
 * Invalidate the cached redirect pattern rules.
 * Call when redirects are created, updated, or deleted.
 */
export function invalidateRedirectCache(): void {
	cachedPatternRules = null;
}

/** Static asset extensions -- don't redirect file requests */
const ASSET_EXTENSION = /\.\w{1,10}$/;

type RedirectCode = 301 | 302 | 303 | 307 | 308;

function isRedirectCode(code: number): code is RedirectCode {
	return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;

	// Skip internal paths and static assets
	if (SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
		return next();
	}
	if (ASSET_EXTENSION.test(pathname)) {
		return next();
	}

	const { emdash } = context.locals;
	if (!emdash?.db) {
		return next();
	}

	try {
		const repo = new RedirectRepository(emdash.db);

		// 1. Exact match (fast, indexed)
		const exact = await repo.findExactMatch(pathname);
		if (exact) {
			const dest = exact.destination;
			if (dest.startsWith("//") || dest.startsWith("/\\")) return next();
			repo.recordHit(exact.id).catch(() => {});
			const code = isRedirectCode(exact.type) ? exact.type : 301;
			return context.redirect(dest, code);
		}

		// 2. Pattern match (cached: compile once, match every request)
		if (!cachedPatternRules) {
			const patterns = await repo.findEnabledPatternRules();
			cachedPatternRules = patterns.map((r) => ({
				redirect: r,
				compiled: compilePattern(r.source),
			}));
		}

		for (const { redirect, compiled } of cachedPatternRules) {
			const params = matchPattern(compiled, pathname);
			if (params) {
				const dest = interpolateDestination(redirect.destination, params);
				if (dest.startsWith("//") || dest.startsWith("/\\")) return next();
				repo.recordHit(redirect.id).catch(() => {});
				const code = isRedirectCode(redirect.type) ? redirect.type : 301;
				return context.redirect(dest, code);
			}
		}

		// No redirect matched -- proceed and check for 404
		const response = await next();

		// Log 404s for unmatched paths (fire-and-forget)
		if (response.status === 404) {
			const referrer = context.request.headers.get("referer") ?? null;
			const userAgent = context.request.headers.get("user-agent") ?? null;
			repo
				.log404({
					path: pathname,
					referrer,
					userAgent,
				})
				.catch(() => {});
		}

		return response;
	} catch {
		// If the redirects table doesn't exist yet (pre-migration), skip silently
		return next();
	}
});
