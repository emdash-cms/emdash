/**
 * Search endpoint - Full-text search across collections
 *
 * GET /_emdash/api/search?q=query&collections=posts,pages&limit=20
 */

import type { APIRoute } from "astro";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { searchQuery } from "#api/schemas.js";
import { searchWithDb } from "#search/index.js";

export const prerender = false;

/**
 * Search content
 *
 * Query parameters:
 * - q: Search query (required)
 * - collections: Comma-separated list of collection slugs (optional, defaults to all)
 * - status: Filter by status (optional, defaults to 'published')
 * - limit: Maximum results (optional, defaults to 20)
 */
export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const query = parseQuery(url, searchQuery);
	if (isParseError(query)) return query;

	const collections = query.collections
		? query.collections.split(",").map((c: string) => c.trim())
		: undefined;

	try {
		// Verify FTS indexes are healthy on first use. At most once per worker
		// lifetime; no-op after that. Moved off the cold-start hot path to
		// keep anonymous public reads fast.
		await emdash.ensureSearchHealthy?.();

		const result = await searchWithDb(emdash.db, query.q, {
			collections,
			status: query.status,
			locale: query.locale,
			limit: query.limit,
		});

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Search failed", "SEARCH_ERROR");
	}
};
