/**
 * Unpublish content - removes from public view, preserves draft
 *
 * POST /_emdash/api/content/{collection}/{id}/unpublish
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentUnpublish || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Fetch item to check ownership
	const existing = await emdash.handleContentGet(collection, id);
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
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	const denied = requireOwnerPerm(user, authorId, "content:publish_own", "content:publish_any");
	if (denied) return denied;

	const resolvedId = typeof existingItem?.id === "string" ? existingItem.id : id;

	const result = await emdash.handleContentUnpublish(collection, resolvedId);

	if (!result.success) return unwrapResult(result);

	if (cache?.enabled) await cache.invalidate({ tags: [collection, resolvedId] });

	return unwrapResult(result);
};
