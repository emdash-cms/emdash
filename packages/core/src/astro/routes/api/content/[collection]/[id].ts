/**
 * Single content item endpoints - injected by EmDash integration
 *
 * GET    /_emdash/api/content/{collection}/{id} - Get content
 * PUT    /_emdash/api/content/{collection}/{id} - Update content
 * DELETE /_emdash/api/content/{collection}/{id} - Delete content
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { saveContent } from "#api/content-save.js";
import { apiError, apiSuccess, mapErrorStatus, unwrapResult } from "#api/error.js";
import { claimEntryLockForWrite } from "#api/handlers/entry-lock.js";
import { parseBody, isParseError } from "#api/parse.js";
import { contentUpdateBody } from "#api/schemas.js";
import { invalidateRouteCache } from "#cache/route-cache.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;
	const collection = params.collection!;
	const id = params.id!;
	const locale = url.searchParams.get("locale") || undefined;

	const result = await emdash.handleContentGet(collection, id, locale, {
		includeDrafts: hasPermission(user, "content:read_drafts"),
	});

	// Hide non-published items from users without content:read_drafts. Return
	// 404 (not 403) so subscribers can't enumerate draft IDs by status code.
	if (result.success && !hasPermission(user, "content:read_drafts")) {
		const { liveData, draftRevisionId: _draftRevisionId, ...item } = result.data.item;
		if (item.status !== "published") {
			return apiError("NOT_FOUND", `Content item not found: ${id}`, 404);
		}

		// Strip draft hydration data from response for users without read_drafts.
		// handleContentGet overlays draft revision data onto item.data and exposes
		// the published values in item.liveData. Without this, subscribers see
		// unpublished edits in the data field.
		return apiSuccess({ ...result.data, item: { ...item, data: liveData ?? item.data } });
	}

	return unwrapResult(result);
};

export const PUT: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;
	const locale = new URL(request.url).searchParams.get("locale") || undefined;
	const body = await parseBody(request, contentUpdateBody);
	if (isParseError(body)) return body;

	if (!emdash?.handleContentUpdate || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const { overrideLock, ...saveBody } = body;
	// saveContent resolves a slug to the entry's ID before it calls beforeWrite.
	let resolvedId = id;
	const result = await saveContent(emdash, {
		collection,
		id,
		locale,
		user,
		body: saveBody,
		beforeWrite: async (entryId) => {
			resolvedId = entryId;
			const refusal = await claimEntryLockForWrite(emdash.db, collection, entryId, user!.id, {
				override: overrideLock,
			});
			return (
				refusal && { code: refusal.code, message: refusal.message, details: { ...refusal.details } }
			);
		},
	});

	if (!result.success) return unwrapResult(result);

	if (result.liveContentChanged !== false) {
		await invalidateRouteCache(cache, [collection, resolvedId]);
	}

	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, locals, url, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentDelete || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const locale = url.searchParams.get("locale") || undefined;

	// Fetch item to check ownership
	const existing = await emdash.handleContentGet(collection, id, locale);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}

	const deleteItem = existing.data.item;
	const deleteDenied = requireOwnerPerm(
		user,
		deleteItem.authorId ?? "",
		"content:delete_own",
		"content:delete_any",
	);
	if (deleteDenied) return deleteDenied;

	// Use the resolved ID (handles slug → ID resolution)
	const resolvedId = deleteItem.id;

	// DELETE carries no body, so the lock opt-out rides on the query string.
	const refusal = await claimEntryLockForWrite(emdash.db, collection, resolvedId, user!.id, {
		override: url.searchParams.get("overrideLock") === "true",
	});
	if (refusal) {
		return apiError(refusal.code, refusal.message, mapErrorStatus(refusal.code), {
			...refusal.details,
		});
	}

	const result = await emdash.handleContentDelete(collection, resolvedId, {
		actor: { id: user!.id, role: user!.role },
	});

	if (!result.success) return unwrapResult(result);

	await invalidateRouteCache(cache, [collection, resolvedId]);

	return unwrapResult(result);
};
