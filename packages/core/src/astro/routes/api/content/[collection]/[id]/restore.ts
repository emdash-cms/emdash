/**
 * Restore content from trash endpoint - injected by EmDash integration
 *
 * POST /_emdash/api/content/{collection}/{id}/restore - Restore from trash
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentRestore || !emdash?.handleContentGetIncludingTrashed) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Fetch item including trashed items to check ownership
	const existing = await emdash.handleContentGetIncludingTrashed(collection, id);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}
	const existingData =
		existing.data && typeof existing.data === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown data; narrowed by typeof check above
				(existing.data as Record<string, unknown>)
			: undefined;
	// Handler returns { item, _rev } — extract the item for ownership check
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	const denied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
	if (denied) return denied;

	const resolvedId = typeof existingItem?.id === "string" ? existingItem.id : id;

	const result = await emdash.handleContentRestore(collection, resolvedId);

	if (!result.success) return unwrapResult(result);

	if (cache.enabled) await cache.invalidate({ tags: [collection, resolvedId] });

	return unwrapResult(result);
};
