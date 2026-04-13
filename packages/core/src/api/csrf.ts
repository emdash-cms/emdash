/**
 * CSRF protection utilities.
 *
 * Two mechanisms:
 * 1. Custom header check (X-EmDash-Request: 1) — used for authenticated API routes.
 *    Browsers block cross-origin custom headers, so presence proves same-origin.
 * 2. Origin check — used for public API routes that skip auth. Compares the Origin
 *    header against the request origin. Same approach as Astro's `checkOrigin`.
 */

import { apiError } from "./error.js";

/**
 * Origin-based CSRF check for public API routes that skip auth.
 *
 * State-changing requests (POST/PUT/DELETE) to public endpoints must either:
 *   1. Include the X-EmDash-Request: 1 header (custom header blocked cross-origin), OR
 *   2. Have an Origin header matching the request origin (or the configured public origin)
 *
 * This prevents cross-origin form submissions (which can't set custom headers)
 * and cross-origin fetch (blocked by CORS unless allowed). Same-origin requests
 * always include a matching Origin header.
 *
 * Returns a 403 Response if the check fails, or null if allowed.
 *
 * @param request  The incoming request
 * @param url      The request URL (internal origin)
 * @param publicOrigin  The public-facing origin from config.siteUrl. Must be
 *        `undefined` when absent — never `null` or `""` (security invariant H-1a).
 */
export function checkPublicCsrf(
	request: Request,
	url: URL,
	publicOrigin?: string,
): Response | null {
	// Custom header present — browser blocks cross-origin custom headers
	const csrfHeader = request.headers.get("X-EmDash-Request");
	if (csrfHeader === "1") return null;

	// Check Origin header — present on all POST/PUT/DELETE from browsers
	const origin = request.headers.get("Origin");
	if (origin) {
		try {
			const originUrl = new URL(origin);
			// Accept if Origin matches either the internal or public origin
			if (originUrl.origin === url.origin) return null;
			if (publicOrigin && originUrl.origin === publicOrigin) return null;
		} catch {
			// Malformed Origin — fall through to reject
		}

		return apiError("CSRF_REJECTED", "Cross-origin request blocked", 403);
	}

	// No Origin header — non-browser client (curl, server-to-server).
	// Allow these through since CSRF is a browser-specific attack vector.
	// Server-to-server requests don't carry ambient credentials (cookies).
	return null;
}
