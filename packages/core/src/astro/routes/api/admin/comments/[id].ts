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
		const existing = cache?.enabled
			? await emdash.db
					.selectFrom("_emdash_comments")
					.select(["collection", "content_id"])
					.where("id", "=", id)
					.executeTakeFirst()
			: undefined;

		const result = await handleCommentDelete(emdash.db, id);
		if (result.success && existing) {
			await invalidateRouteCache(cache, [existing.collection, existing.content_id]);
		}
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete comment", "COMMENT_DELETE_ERROR");
	}
};
