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

import { RedirectRepository } from "../../database/repositories/redirect.js";
import { getDb } from "../../loader.js";
import { loadCachedRedirects, matchCachedPatterns } from "../../redirects/cache.js";
import { isTerminalStatus } from "../../redirects/status.js";

/** Paths that should never be intercepted by redirects */
const SKIP_PREFIXES = ["/_emdash", "/_image"];

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

	// Public visitors hit the runtime's anonymous fast path, which intentionally
	// omits `db` from `locals.emdash` to keep the public render boundary minimal
	// (issue #808). Fall back to `getDb()`, which transparently returns the
	// per-request scoped db (set in ALS by the runtime middleware) or the
	// singleton — same path the loader and template helpers use.
	let db = context.locals.emdash?.db;
	if (!db) {
		try {
			db = await getDb();
		} catch {
			return next();
		}
	}

	try {
		const repo = new RedirectRepository(db);

		// One query loads both exact and pattern rules into the cache; warm
		// requests issue zero queries. Empty-redirect sites cache an empty
		// Map + array, so the next request returns immediately without probing.
		const cached = await loadCachedRedirects(() => repo.findAllEnabled());

		// 1. Exact match (O(1) Map lookup)
		let exact = cached.exact.get(pathname);
		if (!exact && pathname.length > 1) {
			const alt = pathname.endsWith("/") ? pathname.slice(0, -1) : `${pathname}/`;
			exact = cached.exact.get(alt);
		}
		if (exact) {
			// Terminal statuses (410 Gone / 451): serve the status directly,
			// with no Location header.
			if (isTerminalStatus(exact.type)) {
				repo.recordHit(exact.id).catch(() => {});
				return new Response(null, { status: exact.type });
			}
			const dest = exact.destination;
			if (dest.startsWith("//") || dest.startsWith("/\\")) return next();
			repo.recordHit(exact.id).catch(() => {});
			const code = isRedirectCode(exact.type) ? exact.type : 301;
			return context.redirect(dest, code);
		}

		// 2. Pattern match (compile once, match every request)
		const patternMatch = matchCachedPatterns(cached.patterns, pathname);
		if (patternMatch) {
			const { redirect, destination } = patternMatch;
			// Terminal statuses (410 Gone / 451): serve the status directly.
			if (isTerminalStatus(redirect.type)) {
				repo.recordHit(redirect.id).catch(() => {});
				return new Response(null, { status: redirect.type });
			}
			if (destination.startsWith("//") || destination.startsWith("/\\")) return next();
			repo.recordHit(redirect.id).catch(() => {});
			const code = isRedirectCode(redirect.type) ? redirect.type : 301;
			return context.redirect(destination, code);
		}

		// No redirect matched -- proceed and check for 404
		const response = await next();

		// Log misses (fire-and-forget) under the path the visitor requested.
		// Two shapes count as a miss: an unmatched route rendering the error
		// page with status 404, and a matched route answering a content miss
		// with a redirect to /404 (the documented template pattern) — there the
		// missed path exists only on this first pass, before the browser
		// follows the redirect. The error page itself is never logged: /404
		// answers 404 by design and carries no path information.
		const location = response.headers.get("location");
		const missedByRedirect =
			isRedirectCode(response.status) && (location === "/404" || location === "/404/");
		const missedDirectly = response.status === 404 && pathname !== "/404" && pathname !== "/404/";
		if (missedDirectly || missedByRedirect) {
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
