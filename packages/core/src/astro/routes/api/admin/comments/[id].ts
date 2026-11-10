/**
 * Single comment admin endpoints
 *
 * GET    /_emdash/api/admin/comments/:id - Get comment detail
 * DELETE /_emdash/api/admin/comments/:id - Hard delete (ADMIN only)
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleCommentGet, handleCommentDelete } from "#api/handlers/comments.js";
import { invalidateRouteCache } from "#cache/route-cache.js";
import { getCommentRouteCacheTags } from "#comments/route-cache.js";

export const prerender = false;

/**
 * Get single comment detail (includes moderation_metadata)
 */
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!id) {
		return apiError("VALIDATION_ERROR", "Comment ID required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "comments:moderate");
	if (denied) return denied;

	try {
		const result = await handleCommentGet(emdash.db, id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get comment", "COMMENT_GET_ERROR");
	}
};

/**
 * Hard delete a comment (ADMIN only)
 */
export const DELETE: APIRoute = async ({ params, locals, cache }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!id) {
		return apiError("VALIDATION_ERROR", "Comment ID required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "comments:delete");
	if (denied) return denied;

	try {
		const tags = cache?.enabled ? await getCommentRouteCacheTags(emdash.db, [id], "delete") : [];

		try {
			return unwrapResult(await handleCommentDelete(emdash.db, id));
		} finally {
			if (tags.length > 0) await invalidateRouteCache(cache, tags);
		}
	} catch (error) {
		return handleError(error, "Failed to delete comment", "COMMENT_DELETE_ERROR");
	}
};
