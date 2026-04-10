/**
 * Search suggestions endpoint - Autocomplete
 *
 * GET /_emdash/api/search/suggest?q=hel&limit=5
 */

import type { APIRoute } from "astro";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { searchSuggestQuery } from "#api/schemas.js";
import { getSuggestions } from "#search/index.js";

export const prerender = false;

/**
 * Get search suggestions for autocomplete
 *
 * Query parameters:
 * - q: Partial search query (required)
 * - collections: Comma-separated list of collection slugs (optional)
 * - limit: Maximum suggestions (optional, defaults to 5)
 */
export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const query = parseQuery(url, searchSuggestQuery);
	if (isParseError(query)) return query;

	const collections = query.collections
		? query.collections.split(",").map((c: string) => c.trim())
		: undefined;

	try {
		const suggestions = await getSuggestions(emdash.db, query.q, {
			collections,
			locale: query.locale,
			limit: query.limit,
		});

		return apiSuccess({ items: suggestions });
	} catch (error) {
		return handleError(error, "Failed to get suggestions", "SUGGESTION_ERROR");
	}
};
