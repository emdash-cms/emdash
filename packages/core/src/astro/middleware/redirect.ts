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

import type { APIContext } from "astro";
import { defineMiddleware } from "astro:middleware";

import { after } from "../../after.js";
import { RedirectRepository } from "../../database/repositories/redirect.js";
import { getDb } from "../../loader.js";
import { createRedirectSource } from "../../redirects/artifacts.js";
import type { CachedRedirects, RedirectRule } from "../../redirects/cache.js";
import { loadCachedRedirects, matchCachedPatterns } from "../../redirects/cache.js";
import { isSiteRelativeDestination } from "../../redirects/destination.js";
import { isTerminalStatus } from "../../redirects/status.js";

/** Paths that should never be intercepted by redirects */
const SKIP_PREFIXES = ["/_emdash", "/_image"];

/** Static asset extensions -- don't redirect file requests */
const ASSET_EXTENSION = /\.\w{1,10}$/;

type RedirectCode = 301 | 302 | 303 | 307 | 308;

function isRedirectCode(code: number): code is RedirectCode {
	return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

function warnUnsafeDestination(id: string): void {
	console.warn(
		`[emdash:redirects] Skipping redirect ${id}: destination is not a site-relative path`,
	);
}

function recordHitInBackground(repo: RedirectRepository, id: string): void {
	after(async () => {
		try {
			await repo.recordHit(id);
		} catch (error) {
			console.error("[emdash:redirects] failed to record redirect hit:", error);
		}
	});
}

interface RedirectMatch {
	redirect: RedirectRule;
	destination: string;
}

/** Exact rules first, with or without a trailing slash, then patterns in precedence order. */
function matchRedirect(cached: CachedRedirects, pathname: string): RedirectMatch | null {
	let exact = cached.exact.get(pathname);
	if (!exact && pathname.length > 1) {
		const alt = pathname.endsWith("/") ? pathname.slice(0, -1) : `${pathname}/`;
		exact = cached.exact.get(alt);
	}
	if (exact) return { redirect: exact, destination: exact.destination };
	return matchCachedPatterns(cached.patterns, pathname);
}

/** The response for a matched rule, or null when its destination is not safe to send. */
function redirectResponse(
	context: APIContext,
	repo: RedirectRepository,
	{ redirect, destination }: RedirectMatch,
): Response | null {
	// Terminal statuses (410 Gone / 451): serve the status directly,
	// with no Location header.
	if (isTerminalStatus(redirect.type)) {
		recordHitInBackground(repo, redirect.id);
		return new Response(null, { status: redirect.type });
	}
	if (!isSiteRelativeDestination(destination)) {
		warnUnsafeDestination(redirect.id);
		return null;
	}
	recordHitInBackground(repo, redirect.id);
	const code = isRedirectCode(redirect.type) ? redirect.type : 301;
	return context.redirect(destination, code);
}

/** Whether Astro's route cache will store the response: it does once a max age or a tag is set. */
function routeCacheStores(cache: APIContext["cache"] | undefined): boolean {
	if (!cache?.enabled) return false;
	const { maxAge, tags } = cache.options;
	return maxAge !== undefined || (tags?.length ?? 0) > 0;
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
		const source = createRedirectSource(db);
		const routeCache: APIContext["cache"] | undefined = context.cache;

		// One query loads the published rules into the cache; warm requests
		// issue zero queries, and an expired cache checks the published version
		// in the background. Empty-redirect sites cache an empty Map + array.
		// A response the route cache stores is served to every visitor until it
		// is purged, so before one is returned the rules are verified current.
		let cached = await loadCachedRedirects(source);
		let match = matchRedirect(cached, pathname);
		let verified = false;
		if (match && routeCacheStores(routeCache)) {
			cached = await loadCachedRedirects(source, { verify: true });
			verified = true;
			match = matchRedirect(cached, pathname);
		}
		if (match) return redirectResponse(context, repo, match) ?? next();

		// No redirect matched -- proceed and check for 404
		const response = await next();

		// Keep a 404 out of the route cache: publishing the missing entry later
		// purges content tags, not the missed path, so a cached 404 would outlive
		// the fix. Astro has no cache handle for URLs that match no route, but a
		// page answering a content miss with Astro.rewrite("/404") has one.
		if (response.status === 404) {
			routeCache?.set(false);
		}

		if (!verified && routeCacheStores(routeCache)) {
			const current = await loadCachedRedirects(source, { verify: true }).catch(() => cached);
			const late = current === cached ? null : matchRedirect(current, pathname);
			const redirected = late && redirectResponse(context, repo, late);
			if (redirected) {
				routeCache?.set(false);
				// Finish the discarded render instead of cancelling it: a render cut off
				// with its request never settles an isolate-wide fetch it started, and
				// every later render awaiting that fetch hangs.
				after(() => response.body?.pipeTo(new WritableStream()));
				return redirected;
			}
		}

		// Log misses under the path the visitor requested.
		// Two shapes count as a miss: a 404 response (an unmatched route, or a
		// page answering a content miss with Astro.rewrite("/404")), and a
		// matched route answering a content miss with a redirect to /404 —
		// there the missed path exists only on this first pass, before the
		// browser follows the redirect. The error page itself is never logged: /404
		// answers 404 by design and carries no path information.
		const location = response.headers.get("location");
		const missedByRedirect =
			isRedirectCode(response.status) && (location === "/404" || location === "/404/");
		const missedDirectly = response.status === 404 && pathname !== "/404" && pathname !== "/404/";
		if (missedDirectly || missedByRedirect) {
			const referrer = context.request.headers.get("referer") ?? null;
			const userAgent = context.request.headers.get("user-agent") ?? null;
			after(async () => {
				try {
					await repo.log404({
						path: pathname,
						referrer,
						userAgent,
					});
				} catch (error) {
					console.error("[emdash:redirects] failed to log 404:", error);
				}
			});
		}

		return response;
	} catch {
		// If the redirects table doesn't exist yet (pre-migration), skip silently
		return next();
	}
});
