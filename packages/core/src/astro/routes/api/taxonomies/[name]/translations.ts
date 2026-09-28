/**
 * Taxonomy definition translation endpoints
 *
 * GET /_emdash/api/taxonomies/:name/translations[?locale=xx]
 *
 * Creating a translation goes through `POST /_emdash/api/taxonomies` with
 * `translationOf`, so there is no POST here.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleTaxonomyDefTranslations, handleTaxonomyGet } from "#api/handlers/taxonomies.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { localeFilterQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name } = params;
	if (!name) return apiError("VALIDATION_ERROR", "Taxonomy name required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:read");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		// Any locale's row will do — they share the translation_group the list is
		// built from.
		const anchor = await handleTaxonomyGet(emdash.db, name, { locale: query.locale });
		if (!anchor.success) return unwrapResult(anchor);
		const result = await handleTaxonomyDefTranslations(emdash.db, anchor.data.taxonomy.id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(
			error,
			"Failed to list taxonomy translations",
			"TAXONOMY_TRANSLATIONS_ERROR",
		);
	}
};
