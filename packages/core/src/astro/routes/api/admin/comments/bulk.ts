/**
 * Bulk comment operations
 *
 * POST /_emdash/api/admin/comments/bulk - Bulk status change or delete
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleCommentBulk } from "#api/handlers/comments.js";
import { isParseError, parseBody } from "#api/parse.js";
import { commentBulkBody } from "#api/schemas.js";
import { invalidateRouteCache } from "#cache/route-cache.js";
import { getCommentRouteCacheTags } from "#comments/route-cache.js";
import { chunks } from "#utils/chunks.js";

export const prerender = false;

const MAX_CACHE_PURGE_TAGS = 100;

export const POST: APIRoute = async ({ request, locals, cache }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	try {
		const body = await parseBody(request, commentBulkBody);
		if (isParseError(body)) return body;

		// Bulk delete requires ADMIN, bulk status change requires EDITOR
		if (body.action === "delete") {
			const denied = requirePerm(user, "comments:delete");
			if (denied) return denied;
		} else {
			const denied = requirePerm(user, "comments:moderate");
			if (denied) return denied;
		}

		const tags = cache?.enabled
			? await getCommentRouteCacheTags(emdash.db, body.ids, body.action)
			: [];

		try {
			return unwrapResult(await handleCommentBulk(emdash.db, body.ids, body.action));
		} finally {
			// D1 can commit earlier batches even when a later batch fails.
			for (const tagBatch of chunks(tags, MAX_CACHE_PURGE_TAGS)) {
				await invalidateRouteCache(cache, tagBatch);
			}
		}
	} catch (error) {
		return handleError(error, "Failed to perform bulk operation", "COMMENT_BULK_ERROR");
	}
};
