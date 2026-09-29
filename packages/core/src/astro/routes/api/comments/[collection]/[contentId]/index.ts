/**
 * Public comment endpoints
 *
 * GET  /_emdash/api/comments/:collection/:contentId - List approved comments
 * POST /_emdash/api/comments/:collection/:contentId - Submit a comment
 */

import type { APIRoute } from "astro";

import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleCommentList } from "#api/handlers/comments.js";
import { submitPublicComment } from "#comments/public-submission.js";

export const prerender = false;

/**
 * List approved comments for a content item (public, no auth required)
 */
export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash } = locals;
	const { collection, contentId } = params;

	if (!collection || !contentId) {
		return apiError("VALIDATION_ERROR", "Collection and content ID required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	try {
		const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);
		const cursor = url.searchParams.get("cursor") ?? undefined;
		const threaded = url.searchParams.get("threaded") === "true";

		// Check collection exists and has comments enabled
		const collectionRow = await emdash.db
			.selectFrom("_emdash_collections")
			.select(["comments_enabled"])
			.where("slug", "=", collection)
			.executeTakeFirst();

		if (!collectionRow) {
			return apiError("NOT_FOUND", `Collection '${collection}' not found`, 404);
		}

		if (!collectionRow.comments_enabled) {
			return apiError("COMMENTS_DISABLED", "Comments are not enabled for this collection", 403);
		}

		const result = await handleCommentList(emdash.db, collection, contentId, {
			limit,
			cursor,
			threaded,
		});

		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to list comments", "COMMENT_LIST_ERROR");
	}
};

/**
 * Submit a comment (public, gated by anti-spam checks)
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { collection, contentId } = params;

	if (!collection || !contentId) {
		return apiError("VALIDATION_ERROR", "Collection and content ID required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	return submitPublicComment(emdash, collection, contentId, request, user);
};
