/**
 * Confirm media upload endpoint
 *
 * POST /_emdash/api/media/{id}/confirm
 *
 * Confirms that the client has successfully uploaded the file to storage.
 * Marks the media record as ready and optionally updates metadata.
 */

import type { APIRoute } from "astro";
import { MediaRepository } from "emdash";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { mediaConfirmBody } from "#api/schemas.js";
import type { MediaItem } from "#types";

export const prerender = false;

/**
 * Add URL to media item (relative URL for portability)
 */
function addUrlToMedia(item: MediaItem): MediaItem & { url: string } {
	return {
		...item,
		url: `/_emdash/api/media/file/${item.storageKey}`,
	};
}

/**
 * Confirm upload completion
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const denied = requirePerm(user, "media:upload");
	if (denied) return denied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Media ID is required", 400);
	}

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseOptionalBody(request, mediaConfirmBody, {});
		if (isParseError(body)) return body;

		const repo = new MediaRepository(emdash.db);

		// Get the media item first to check status
		const existing = await repo.findById(id);
		if (!existing) {
			return apiError("NOT_FOUND", `Media item not found: ${id}`, 404);
		}

		if (existing.status !== "pending") {
			return apiError("INVALID_STATE", `Media item is not pending: ${existing.status}`, 400);
		}

		// Only the uploader or a user with media:edit_any can confirm/fail a pending upload
		const ownerDenied = requireOwnerPerm(
			user,
			existing.authorId ?? "",
			"media:edit_own",
			"media:edit_any",
		);
		if (ownerDenied) return ownerDenied;

		// Optionally verify the file exists in storage
		if (emdash.storage) {
			const exists = await emdash.storage.exists(existing.storageKey);
			if (!exists) {
				// Mark as failed
				await repo.markFailed(id);
				return apiError("FILE_NOT_FOUND", "File was not uploaded to storage", 400);
			}
		}

		// Confirm the upload
		const item = await repo.confirmUpload(id, {
			size: body.size,
			width: body.width,
			height: body.height,
		});

		if (!item) {
			return apiError("CONFIRM_FAILED", "Failed to confirm upload", 500);
		}

		// Add URL to the response (relative URL for portability)
		const itemWithUrl = addUrlToMedia(item);

		return apiSuccess({ item: itemWithUrl });
	} catch (error) {
		return handleError(error, "Failed to confirm upload", "CONFIRM_ERROR");
	}
};
