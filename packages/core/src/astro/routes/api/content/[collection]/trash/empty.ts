/**
 * Empty trash endpoint - injected by EmDash integration
 *
 * POST /_emdash/api/content/{collection}/trash/empty - Permanently delete one batch of trashed items
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, unwrapResult } from "#api/error.js";
import { parseQuery, isParseError } from "#api/parse.js";
import { contentEmptyTrashQuery } from "#api/schemas.js";
import { invalidateRouteCache } from "#cache/route-cache.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, url, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;

	if (!emdash?.handleContentEmptyTrash) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:delete_permanent");
	if (denied) return denied;

	const query = parseQuery(url, contentEmptyTrashQuery);
	if (isParseError(query)) return query;

	const result = await emdash.handleContentEmptyTrash(collection, query);
	if (!result.success) return unwrapResult(result);

	const { deletedIds, remaining } = result.data;
	await invalidateRouteCache(cache, [collection, ...deletedIds]);

	return apiSuccess({ deleted: deletedIds.length, remaining });
};
