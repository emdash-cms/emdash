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

	try {
		// Anonymous public requests may bypass full runtime init, so
		// locals.emdash is not guaranteed to exist here. Fall back to the
		// shared loader database so redirects still work on public traffic.
		const db = context.locals.emdash?.db ?? (await getDb());
		const repo = new RedirectRepository(db);
		const match = await repo.matchPath(pathname);

		if (match) {
			// Reject protocol-relative URLs (e.g. //evil.com or /\evil.com) from interpolation.
			// Browsers normalize backslashes to forward slashes, so /\ is equivalent to //.
			if (
				match.resolvedDestination.startsWith("//") ||
				match.resolvedDestination.startsWith("/\\")
			) {
				return next();
			}
			// Fire-and-forget hit recording (don't block the redirect)
			repo.recordHit(match.redirect.id).catch(() => {});
			const code = isRedirectCode(match.redirect.type) ? match.redirect.type : 301;
			return context.redirect(match.resolvedDestination, code);
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
