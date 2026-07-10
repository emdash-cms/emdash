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
import { moderateComment, type CommentHookRunner } from "#comments/service.js";
import type { ModerationDecision } from "#plugins/types.js";

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

		// Build hook runner for the service
		const hookRunner: CommentHookRunner = {
			async runBeforeCreate(event) {
				return emdash.hooks.runCommentBeforeCreate(event);
			},
			async runModerate(event) {
				const result = await emdash.hooks.invokeExclusiveHook("comment:moderate", event);
				if (!result) return { status: "pending" as const, reason: "No moderator configured" };
				if (result.error) return { status: "pending" as const, reason: "Moderation error" };
				return result.result as ModerationDecision;
			},
			fireAfterCreate(event) {
				emdash.hooks
					.runCommentAfterCreate(event)
					.catch((err) =>
						console.error(
							"[comments] afterCreate error:",
							err instanceof Error ? err.message : err,
						),
					);
			},
			fireAfterModerate(event) {
				emdash.hooks
					.runCommentAfterModerate(event)
					.catch((err) =>
						console.error(
							"[comments] afterModerate error:",
							err instanceof Error ? err.message : err,
						),
					);
			},
		};

		// Read the comment before updating so we know the previous status
		const existing = await handleCommentGet(emdash.db, id);
		if (!existing.success) {
			return unwrapResult(existing);
		}
		const previousStatus = existing.data.status;

		const updated = await moderateComment(
			emdash.db,
			id,
			newStatus,
			{ id: user!.id, name: user!.name ?? null },
			hookRunner,
		);

		if (!updated) {
			return apiError("NOT_FOUND", "Comment not found", 404);
		}

		// Send notification when a comment is newly approved
		if (newStatus === "approved" && previousStatus !== "approved" && emdash.email) {
			try {
				const adminBaseUrl = await getSiteBaseUrl(emdash.db, request);
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
