/**
 * Single media item endpoint
 *
 * GET /_emdash/api/media/:id - Get media item
 * PUT /_emdash/api/media/:id - Update media metadata
 * DELETE /_emdash/api/media/:id - Delete media item
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { mediaUpdateBody } from "#api/schemas.js";

export const prerender = false;

/**
 * Get media item
 */
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const readDenied = requirePerm(user, "media:read");
	if (readDenied) return readDenied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Media ID required", 400);
	}

	if (!emdash?.handleMediaGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const result = await emdash.handleMediaGet(id);
	return unwrapResult(result);
};

/**
 * Update media metadata
 *
 * Authors can edit their own media; editors+ can edit any.
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	// Minimum permission gate — ownership checked below
	const editDenied = requirePerm(user, "media:edit_own");
	if (editDenied) return editDenied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Media ID required", 400);
	}

	if (!emdash?.handleMediaGet || !emdash?.handleMediaUpdate) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Fetch media item for ownership check
		const getResult = await emdash.handleMediaGet(id);
		if (!getResult.success || !getResult.data?.item) {
			return apiError("NOT_FOUND", "Media item not found", 404);
		}

		const media = getResult.data.item;

		// Ownership check: authors can edit own, editors+ can edit any
		const ownerDenied = requireOwnerPerm(user, media.authorId, "media:edit_own", "media:edit_any");
		if (ownerDenied) return ownerDenied;

		const body = await parseBody(request, mediaUpdateBody);
		if (isParseError(body)) return body;

		const result = await emdash.handleMediaUpdate(id, {
			alt: body.alt,
			caption: body.caption,
			width: body.width,
			height: body.height,
		});

		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update media", "MEDIA_UPDATE_ERROR");
	}
};

/**
 * Delete media item
 *
 * Authors can delete their own media; editors+ can delete any.
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	// Minimum permission gate — ownership checked below
	const deleteDenied = requirePerm(user, "media:delete_own");
	if (deleteDenied) return deleteDenied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Media ID required", 400);
	}

	if (!emdash?.handleMediaGet || !emdash?.handleMediaDelete) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Fetch media item for ownership check and storage key
		const getResult = await emdash.handleMediaGet(id);
		if (!getResult.success || !getResult.data?.item) {
			return apiError("NOT_FOUND", "Media item not found", 404);
		}

		const media = getResult.data.item;

		// Ownership check: authors can delete own, editors+ can delete any
		const ownerDenied = requireOwnerPerm(
			user,
			media.authorId,
			"media:delete_own",
			"media:delete_any",
		);
		if (ownerDenied) return ownerDenied;

		// Delete file from storage via the storage adapter
		if (emdash.storage) {
			try {
				await emdash.storage.delete(media.storageKey);
			} catch {
				// Best-effort — continue with database deletion
			}
		}

		// Delete from database — site-settings cache invalidation happens
		// in `EmDashRuntime.handleMediaDelete` so MCP/plugin paths inherit it.
		const result = await emdash.handleMediaDelete(id);

		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete media", "MEDIA_DELETE_ERROR");
	}
};
