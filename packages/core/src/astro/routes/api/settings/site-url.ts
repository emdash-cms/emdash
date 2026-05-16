/**
 * Site URL Settings API endpoint
 *
 * GET  /_emdash/api/settings/site-url — current `emdash:site_url` value
 * POST /_emdash/api/settings/site-url — update `emdash:site_url`
 *
 * Why a dedicated endpoint?
 * The `emdash:site_url` option governs the base URL used to build links in
 * magic-link, invitation, and password-reset emails (see
 * `src/api/site-url.ts` -> `getSiteBaseUrl`). It is written once during the
 * setup wizard via `setIfAbsent()` and was previously not editable from
 * the admin UI. The regular Site Settings form edits `site:url`, which is
 * a separate, presentation-layer URL (used for canonical links/sitemaps)
 * and is not consulted by the auth email path. See issue #989.
 *
 * Keeping this as its own endpoint (rather than rolling it into
 * `POST /_emdash/api/settings`) preserves the existing `site:*` namespace
 * and makes it explicit that this write changes the security-sensitive
 * origin used in transactional emails.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const prerender = false;

const SITE_URL_OPTION = "emdash:site_url";

/**
 * Accept any non-empty string -- shape validation (http/https scheme,
 * parseability) is done after parsing with `URL` so we can produce a
 * single, normalized origin (no path, no trailing slash) before write.
 *
 * Matching `getPublicOrigin()` semantics: the stored value is always an
 * origin like `https://example.com`, never with a path or trailing slash,
 * so subsequent reads in `getSiteBaseUrl()` can append `/_emdash` cleanly.
 */
const siteUrlBody = z.object({
	siteUrl: z.string().min(1).max(2048),
});

/**
 * GET /_emdash/api/settings/site-url
 *
 * Returns `{ siteUrl: string | null }`. `null` means the option has never
 * been set (only possible in the rare case the setup wizard skipped this
 * write -- the wizard writes via `setIfAbsent` on every completion).
 */
export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:read");
	if (denied) return denied;

	try {
		const options = new OptionsRepository(emdash.db);
		const siteUrl = (await options.get<string>(SITE_URL_OPTION)) ?? null;
		return apiSuccess({ siteUrl });
	} catch (error) {
		return handleError(error, "Failed to read site URL", "SITE_URL_READ_ERROR");
	}
};

/**
 * POST /_emdash/api/settings/site-url
 *
 * Updates `emdash:site_url`. Accepts `{ siteUrl: string }` and normalizes
 * to a bare origin (`https://host[:port]`) before persisting.
 *
 * Rejects values that:
 *  - fail `new URL()` parsing,
 *  - use a scheme other than `http:` or `https:` (XSS-prone schemes like
 *    `javascript:` and `data:` must not be writable here -- this value is
 *    interpolated into outgoing email content),
 *  - carry a path, query, or fragment (we want an origin only, to match
 *    how `getSiteBaseUrl` appends `/_emdash`).
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, siteUrlBody);
		if (isParseError(body)) return body;

		let parsed: URL;
		try {
			parsed = new URL(body.siteUrl.trim());
		} catch {
			return apiError(
				"INVALID_SITE_URL",
				"Site URL must be a valid absolute URL (e.g. https://example.com)",
				400,
			);
		}

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return apiError(
				"INVALID_SITE_URL",
				"Site URL must use the http or https scheme",
				400,
			);
		}

		// Allow trailing-slash-only path so users pasting `https://example.com/`
		// from a browser address bar don't get rejected. Anything beyond that
		// (a real path, query string, or fragment) is rejected -- we store an
		// origin, not a deep link.
		if ((parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search || parsed.hash) {
			return apiError(
				"INVALID_SITE_URL",
				"Site URL must be an origin only (no path, query string, or fragment)",
				400,
			);
		}

		const normalized = parsed.origin;

		const options = new OptionsRepository(emdash.db);
		await options.set(SITE_URL_OPTION, normalized);

		return apiSuccess({ siteUrl: normalized });
	} catch (error) {
		return handleError(error, "Failed to update site URL", "SITE_URL_UPDATE_ERROR");
	}
};
