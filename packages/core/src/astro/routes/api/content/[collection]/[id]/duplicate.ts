/**
 * Duplicate content endpoint - injected by EmDash integration
 *
 * POST /_emdash/api/content/{collection}/{id}/duplicate - Create a copy
 *
 * Without a body this is a same-collection duplicate. With
 * `{ targetCollection, ... }` the copy lands in another collection through a
 * field mapping.
 */

import type { APIRoute } from "astro";

import { requirePerm, requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { parseOptionalBody } from "#api/parse.js";
import { contentDuplicateBody } from "#api/schemas/content.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentDuplicate || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:create");
	if (denied) return denied;

	const body = await parseOptionalBody(request, contentDuplicateBody.optional(), undefined);
	if (body instanceof Response) return body;

	// Fetch item to check ownership — duplicating requires read access to the source
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
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- handler returns unknown data; narrowed by typeof check above
				(existing.data as Record<string, unknown>)
			: undefined;
	// Handler returns { item, _rev } — extract the item for ownership check
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	// Duplicating requires read access to the source — check ownership-based edit permissions
	// since content:read is flat (no own/any split). This ensures authors can only duplicate their own.
	const readDenied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
	if (readDenied) return readDenied;

	const resolvedId = typeof existingItem?.id === "string" ? existingItem.id : id;

	if (body) {
		if (!emdash.handleContentDuplicateMany) {
			return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
		}
		const result = await emdash.handleContentDuplicateMany(collection, {
			...body,
			ids: [resolvedId],
			actor: user ? { id: user.id, role: user.role } : undefined,
		});
		if (!result.success) return unwrapResult(result);

		const item = result.data?.results[0];
		if (!item || item.status === "failed") {
			return apiError("DUPLICATE_FAILED", item?.error ?? "Failed to duplicate content", 400);
		}

		if (cache?.enabled) {
			const tags = [body.targetCollection ?? collection];
			if (body.trashSource) tags.push(collection);
			await cache.invalidate({ tags });
		}

		return unwrapResult(result, 201);
	}

	const result = await emdash.handleContentDuplicate(collection, resolvedId, user?.id);

	if (!result.success) return unwrapResult(result);

	if (cache?.enabled) await cache.invalidate({ tags: [collection] });

	return unwrapResult(result, 201);
};
