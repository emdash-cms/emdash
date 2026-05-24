/**
 * Media Provider Item Endpoint
 *
 * GET /_emdash/api/media/providers/:providerId/:itemId - Get single item
 * DELETE /_emdash/api/media/providers/:providerId/:itemId - Delete item
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";

export const prerender = false;

/**
 * Get a single media item from a provider
 */
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "media:read");
	if (denied) return denied;
	const { providerId, itemId } = params;

	if (!providerId || !itemId) {
		return apiError("INVALID_REQUEST", "Provider ID and Item ID required", 400);
	}

	if (!emdash?.getMediaProvider) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const provider = emdash.getMediaProvider(providerId);
	if (!provider) {
		return apiError("NOT_FOUND", `Provider "${providerId}" not found`, 404);
	}

	if (!provider.get) {
		return apiError(
			"NOT_SUPPORTED",
			`Provider "${providerId}" does not support getting individual items`,
			400,
		);
	}

	try {
		const item = await provider.get(itemId);

		if (!item) {
			return apiError("NOT_FOUND", "Item not found", 404);
		}

		return apiSuccess({ item });
	} catch (error) {
		return handleError(error, "Failed to get item from provider", "PROVIDER_GET_ERROR");
	}
};

/**
 * Delete a media item from a provider
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "media:delete_any");
	if (denied) return denied;
	const { providerId, itemId } = params;

	if (!providerId || !itemId) {
		return apiError("INVALID_REQUEST", "Provider ID and Item ID required", 400);
	}

	if (!emdash?.getMediaProvider) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const provider = emdash.getMediaProvider(providerId);
	if (!provider) {
		return apiError("NOT_FOUND", `Provider "${providerId}" not found`, 404);
	}

	if (!provider.delete) {
		return apiError("NOT_SUPPORTED", `Provider "${providerId}" does not support deletion`, 400);
	}

	try {
		await provider.delete(itemId);

		return apiSuccess({ deleted: true });
	} catch (error) {
		return handleError(error, "Failed to delete item from provider", "PROVIDER_DELETE_ERROR");
	}
};
