/**
 * Comment status counts for inbox badges
 *
 * GET /_emdash/api/admin/comments/counts
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleCommentCounts } from "#api/handlers/comments.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "comments:moderate");
	if (denied) return denied;

	try {
		const result = await handleCommentCounts(emdash.db);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get comment counts", "COMMENT_COUNTS_ERROR");
	}
};
