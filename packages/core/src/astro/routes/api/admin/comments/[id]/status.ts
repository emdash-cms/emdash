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
import { getSiteBaseUrl } from "#api/site-url.js";
import { lookupContentAuthor, sendCommentNotification } from "#comments/notifications.js";

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

		const updated = await emdash.handleCommentModerate(id, newStatus, {
			id: user!.id,
			name: user!.name ?? null,
		});

		if (!updated) {
			return apiError("NOT_FOUND", "Comment not found", 404);
		}

		// Send notification when a comment is newly approved
		if (newStatus === "approved" && previousStatus !== "approved" && emdash.email) {
			try {
				const adminBaseUrl = await getSiteBaseUrl(emdash.db, request, emdash.config);
				const content = await lookupContentAuthor(emdash.db, updated.collection, updated.contentId);
				if (content?.author) {
					await sendCommentNotification({
						email: emdash.email,
						comment: updated,
						contentAuthor: content.author,
						adminBaseUrl,
					});
				}
			} catch (err) {
				console.error("[comments] notification error:", err instanceof Error ? err.message : err);
			}
		}

		return apiSuccess(updated);
	} catch (error) {
		return handleError(error, "Failed to update comment status", "COMMENT_STATUS_ERROR");
	}
};
