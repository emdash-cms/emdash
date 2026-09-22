/**
 * Comment status change
 *
 * PUT /_emdash/api/admin/comments/:id/status - Change comment status
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleCommentGet } from "#api/handlers/comments.js";
import { isParseError, parseBody } from "#api/parse.js";
import { commentStatusBody } from "#api/schemas.js";
import { CommentStatusConflictError } from "#comments/service.js";

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, locals }) => {
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
		const body = await parseBody(request, commentStatusBody);
		if (isParseError(body)) return body;

		const newStatus = body.status;

		// Read the comment before updating so we know the previous status
		const existing = await handleCommentGet(emdash.db, id);
		if (!existing.success) {
			return unwrapResult(existing);
		}
		const previousStatus = existing.data.status;
		if (!emdash.handleCommentModerate) {
			return apiError("COMMENT_MODERATION_UNAVAILABLE", "Comment moderation is unavailable", 500);
		}

		const updated = await emdash.handleCommentModerate(
			id,
			newStatus,
			{ id: user!.id, name: user!.name ?? null },
			previousStatus,
			request,
		);

		if (!updated) {
			return apiError("NOT_FOUND", "Comment not found", 404);
		}

		return apiSuccess(updated);
	} catch (error) {
		if (error instanceof CommentStatusConflictError) {
			return apiError(error.code, error.message, 409, { currentStatus: error.currentStatus });
		}
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "COMMENT_MODERATION_IN_PROGRESS"
		) {
			return apiError(
				"COMMENT_MODERATION_IN_PROGRESS",
				"Comment moderation is already in progress",
				409,
			);
		}
		return handleError(error, "Failed to update comment status", "COMMENT_STATUS_ERROR");
	}
};
