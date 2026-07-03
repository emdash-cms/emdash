/**
 * Preview URL endpoint - generates a signed preview URL for content
 *
 * POST /_emdash/api/content/{collection}/{id}/preview-url
 *
 * Request body:
 * {
 *   expiresIn?: string | number;  // Default: "1h"
 *   pathPattern?: string;         // Overrides the resolved default (see below)
 * }
 *
 * Path resolution precedence (highest first):
 *   1. `pathPattern` in the request body (per-call override)
 *   2. `EMDASH_PREVIEW_PATH_PATTERN` env (project-wide override)
 *   3. the collection's configured `url_pattern` — so preview links match the
 *      same routes the sitemap and "View published" links already use (incl.
 *      custom permalinks like `/blog/{slug}`), resolved via the shared
 *      `interpolateUrlPattern` + `localizePath` helpers.
 *   4. the generic `/{collection}/{id}` fallback.
 *
 * Response:
 * {
 *   url: string;      // The preview URL with token
 *   expiresAt: number; // Unix timestamp when token expires
 * }
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { parseOptionalBody, isParseError } from "#api/parse.js";
import { contentPreviewUrlBody } from "#api/schemas.js";
import { resolveSecretsCached } from "#config/secrets.js";
import { buildPreviewUrl, generatePreviewToken, getPreviewUrl } from "#preview/index.js";
import { getCollectionInfoWithDb } from "#schema/query.js";

import { getI18nConfig } from "../../../../../../i18n/config.js";
import { interpolateUrlPattern, localizePath } from "../../../../../../i18n/resolve.js";

export const prerender = false;

const DURATION_PATTERN = /^(\d+)([smhdw])$/;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Resolve the preview secret. Env override wins; otherwise a stable
	// site-specific value is read from (or generated into) the options table.
	// The resolver always returns a usable secret, so this path can no
	// longer be silently disabled by a missing env var.
	const { previewSecret } = await resolveSecretsCached(emdash.db);

	// Verify the content exists. The fetched item also yields the entry's
	// locale and slug, used below to resolve the public path.
	let entryLocale: string | null = null;
	let entrySlug: string | null = null;
	if (emdash?.handleContentGet) {
		const result = await emdash.handleContentGet(collection, id);
		if (!result.success) return unwrapResult(result);
		entryLocale = result.data?.item?.locale ?? null;
		entrySlug = result.data?.item?.slug ?? null;
	}

	// Parse request body
	const body = await parseOptionalBody(request, contentPreviewUrlBody, {});
	if (isParseError(body)) return body;

	const expiresIn = body.expiresIn || "1h";
	// A project-wide default `pathPattern` (body or env) always wins so callers
	// can force a specific shape. When neither is set we resolve the
	// collection's own `url_pattern` below.
	const explicitPattern = body.pathPattern || import.meta.env.EMDASH_PREVIEW_PATH_PATTERN || null;

	// Resolve the locale segment substituted for the `{locale}` placeholder in
	// an explicit pattern: empty when the entry is in the default locale and
	// `prefixDefaultLocale` is `false`, the entry's own locale otherwise.
	const i18n = getI18nConfig();
	let localeSegment = "";
	if (entryLocale && i18n) {
		const isDefault = entryLocale === i18n.defaultLocale;
		localeSegment = isDefault && !i18n.prefixDefaultLocale ? "" : entryLocale;
	} else if (entryLocale) {
		localeSegment = entryLocale;
	}

	// Calculate expiry timestamp
	const expiresInSeconds = typeof expiresIn === "number" ? expiresIn : parseExpiresIn(expiresIn);
	const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

	try {
		// No explicit override: reuse the collection's `url_pattern` so the
		// preview link points at the same route the sitemap and "View
		// published" links already use (custom permalinks like `/blog/{slug}`,
		// date tokens, etc.). Without this the generic `/{collection}/{id}`
		// fallback 404s on any site whose content isn't served at that path.
		if (!explicitPattern) {
			const collectionInfo = await getCollectionInfoWithDb(emdash.db, collection);
			if (collectionInfo?.urlPattern) {
				const path = interpolateUrlPattern({
					pattern: collectionInfo.urlPattern,
					collection,
					slug: entrySlug || id,
					id,
				});
				// `localizePath` returns null when the entry's locale isn't in the
				// configured i18n list; fall back to the un-prefixed path so we
				// still hand back a usable preview link rather than failing.
				const localized = await localizePath(path, entryLocale ?? "");
				const token = await generatePreviewToken({
					contentId: `${collection}:${id}`,
					expiresIn,
					secret: previewSecret,
				});
				const url = buildPreviewUrl({ path: localized ?? path, token });
				return apiSuccess({ url, expiresAt });
			}
		}

		const url = await getPreviewUrl({
			collection,
			id,
			secret: previewSecret,
			expiresIn,
			pathPattern: explicitPattern || "/{collection}/{id}",
			locale: localeSegment,
		});

		return apiSuccess({ url, expiresAt });
	} catch (error) {
		return handleError(error, "Failed to generate preview URL", "TOKEN_ERROR");
	}
};

/**
 * Parse duration string to seconds
 */
function parseExpiresIn(duration: string): number {
	const match = duration.match(DURATION_PATTERN);
	if (!match) {
		return 3600; // Default 1 hour
	}

	const value = parseInt(match[1], 10);
	const unit = match[2];

	switch (unit) {
		case "s":
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 60 * 60;
		case "d":
			return value * 60 * 60 * 24;
		case "w":
			return value * 60 * 60 * 24 * 7;
		default:
			return 3600;
	}
}
