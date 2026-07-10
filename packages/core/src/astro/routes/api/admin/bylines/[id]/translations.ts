/**
 * Byline translation endpoints
 *
 * GET  /_emdash/api/admin/bylines/:id/translations  — list every translation
 *                                                     of a byline (siblings
 *                                                     in the same
 *                                                     translation_group)
 * POST /_emdash/api/admin/bylines/:id/translations  — create a new locale
 *                                                     variant joining the
 *                                                     source's
 *                                                     translation_group
 *                                                     (body: { locale, ... })
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleBylineCreate, handleBylineTranslations } from "#api/handlers/bylines.js";
import { isParseError, parseBody } from "#api/parse.js";
import { bylineTranslationCreateBody } from "#api/schemas.js";
import { invalidateBylineCache } from "#bylines/index.js";
import { BylineRepository } from "#db/repositories/byline.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const id = params.id!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "bylines:read");
	if (denied) return denied;

	try {
		const result = await handleBylineTranslations(emdash.db, id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to fetch byline translations", "BYLINE_TRANSLATIONS_ERROR");
	}
};

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const id = params.id!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "bylines:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, bylineTranslationCreateBody);
		if (isParseError(body)) return body;

		// Look up the source byline so we can:
		//  (a) emit a clean 404 when it doesn't exist (route layer);
		//  (b) fall back to its slug + display_name + avatar/website when
		//      the body omits them. Editors creating a translation often
		//      want to keep the slug stable and only enter the localized
		//      bio/displayName — defaulting saves clicks.
		const repo = new BylineRepository(emdash.db);
		const source = await repo.findById(id);
		if (!source) {
			return new Response(
				JSON.stringify({ error: { code: "NOT_FOUND", message: "Byline not found" } }),
				{ status: 404, headers: { "Content-Type": "application/json" } },
			);
		}

		const result = await handleBylineCreate(emdash.db, {
			slug: body.slug ?? source.slug,
			displayName: body.displayName ?? source.displayName,
			bio: body.bio ?? null,
			avatarMediaId: body.avatarMediaId ?? source.avatarMediaId,
			websiteUrl: body.websiteUrl ?? source.websiteUrl,
			// Translations don't inherit the source's user_id or guest flag —
			// the partial unique on (user_id, locale) means a single user can
			// own one byline per locale, but the editor must opt into linking
			// the new row by editing it after creation.
			userId: null,
			isGuest: source.isGuest,
			locale: body.locale,
			translationOf: id,
		});

		if (result.success) invalidateBylineCache();
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(
			error,
			"Failed to create byline translation",
			"BYLINE_TRANSLATION_CREATE_ERROR",
		);
	}
};
