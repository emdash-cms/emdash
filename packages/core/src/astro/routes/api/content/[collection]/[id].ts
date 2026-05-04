/**
 * Single content item endpoints - injected by EmDash integration
 *
 * GET    /_emdash/api/content/{collection}/{id} - Get content
 * PUT    /_emdash/api/content/{collection}/{id} - Update content
 * DELETE /_emdash/api/content/{collection}/{id} - Delete content
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm, requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { parseBody, isParseError } from "#api/parse.js";
import { contentUpdateBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;
	const collection = params.collection!;
	const id = params.id!;
	const locale = url.searchParams.get("locale") || undefined;

	if (!emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const result = await emdash.handleContentGet(collection, id, locale);

	// Hide non-published items from users without content:read_drafts. Return
	// 404 (not 403) so subscribers can't enumerate draft IDs by status code.
	if (result.success && !hasPermission(user, "content:read_drafts")) {
		const data =
			result.data && typeof result.data === "object"
				? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown data; narrowed by typeof check
					(result.data as Record<string, unknown>)
				: undefined;
		const item =
			data?.item && typeof data.item === "object"
				? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check
					(data.item as Record<string, unknown>)
				: undefined;
		const status = typeof item?.status === "string" ? item.status : null;
		if (status !== "published") {
			return apiError("NOT_FOUND", `Content item not found: ${id}`, 404);
		}

		// Strip draft hydration data from response for users without read_drafts.
		// handleContentGet overlays draft revision data onto item.data and exposes
		// the published values in item.liveData. Without this, subscribers see
		// unpublished edits in the data field.
		if (item) {
			if (item.liveData && typeof item.liveData === "object") {
				item.data = item.liveData;
			}
			delete item.liveData;
			delete item.draftRevisionId;
		}
	}

	return unwrapResult(result);
};

export const PUT: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;
	const body = await parseBody(request, contentUpdateBody);
	if (isParseError(body)) return body;

	if (!emdash?.handleContentUpdate || !emdash?.handleContentGet) {
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
	// Handler returns { item, _rev } — extract the item for ownership and ID resolution
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	const editDenied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
	if (editDenied) return editDenied;

	// Only EDITOR+ can write publishedAt directly — incl. clearing to null.
	if (body.publishedAt !== undefined && !hasPermission(user, "content:publish_any")) {
		return apiError(
			"FORBIDDEN",
			"Writing publishedAt requires content:publish_any permission",
			403,
		);
	}

	// Use the resolved ID (handles slug → ID resolution)
	const resolvedId = typeof existingItem?.id === "string" ? existingItem.id : id;

	// Only allow authorId changes if user has content:edit_any permission (editor+)
	const canChangeAuthor =
		body.authorId !== undefined && user && hasPermission(user, "content:edit_any");
	const updateBody = canChangeAuthor ? body : { ...body, authorId: undefined };

	// Pass _rev through for optimistic concurrency validation
	const result = await emdash.handleContentUpdate(collection, resolvedId, {
		...updateBody,
		_rev: body._rev,
	});

	if (!result.success) return unwrapResult(result);

	if (cache.enabled) await cache.invalidate({ tags: [collection, resolvedId] });

	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentDelete || !emdash?.handleContentGet) {
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

	const deleteData =
		existing.data && typeof existing.data === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown data; narrowed by typeof check above
				(existing.data as Record<string, unknown>)
			: undefined;
	// Handler returns { item, _rev } — extract the item for ownership and ID resolution
	const deleteItem =
		deleteData?.item && typeof deleteData.item === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check above
				(deleteData.item as Record<string, unknown>)
			: deleteData;
	const authorId = typeof deleteItem?.authorId === "string" ? deleteItem.authorId : "";
	const deleteDenied = requireOwnerPerm(user, authorId, "content:delete_own", "content:delete_any");
	if (deleteDenied) return deleteDenied;

	// Use the resolved ID (handles slug → ID resolution)
	const resolvedId = typeof deleteItem?.id === "string" ? deleteItem.id : id;

	const result = await emdash.handleContentDelete(collection, resolvedId);

	if (!result.success) return unwrapResult(result);

	if (cache.enabled) await cache.invalidate({ tags: [collection, resolvedId] });

	return unwrapResult(result);
};
