/**
 * Single content item endpoints - injected by EmDash integration
 *
 * GET    /_emdash/api/content/{collection}/{id} - Get content
 * PUT    /_emdash/api/content/{collection}/{id} - Update content
 * DELETE /_emdash/api/content/{collection}/{id} - Delete content
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm, toPublishedView } from "#api/authorize.js";
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
		if (result.data.item.status !== "published") {
			return apiError("NOT_FOUND", `Content item not found: ${id}`, 404);
		}

		// handleContentGet overlays draft revision data onto item.data and exposes
		// the published values in item.liveData.
		const { _rev: _unusedRev, ...data } = result.data;
		return apiSuccess({ ...data, item: toPublishedView(result.data.item) });
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

	if (!emdash?.handleContentUpdate || !emdash?.handleContentGetForWrite) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// `status` is never saved as a column: setting a published or scheduled entry
	// to draft goes through the unpublish handler, so its hooks run and the live
	// revision and any schedule are cleared.
	const { overrideLock, status, ...saveBody } = body;

	let unpublishing = false;
	if (status === "draft") {
		const existing = await emdash.handleContentGet(collection, id, locale);
		if (!existing.success) return unwrapResult(existing);
		const existingItem = existing.data.item;
		if (
			existingItem.status !== "draft" ||
			existingItem.liveRevisionId ||
			existingItem.scheduledAt
		) {
			const denied = requireOwnerPerm(
				user,
				existingItem.authorId ?? "",
				"content:publish_own",
				"content:publish_any",
			);
			if (denied) return denied;
			unpublishing = true;
		}
	}

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

	if (unpublishing) {
		// A draft-only save rereads the entry after staging, so `data._rev` can belong to a
		// concurrent write. `saved.rev` is this save's own.
		const saved: unknown = result.data;
		const savedRev =
			result.saved?.rev ??
			(saved && typeof saved === "object" && "_rev" in saved && typeof saved._rev === "string"
				? saved._rev
				: undefined);
		const unpublished = await emdash.handleContentUnpublish(collection, resolvedId, {
			// The save advanced the entry's `_rev`. A request without one stays unconditional.
			_rev: saveBody._rev === undefined ? undefined : savedRev,
			actor: { id: user!.id, role: user!.role },
			origin: { source: "api" },
		});
		if (unpublished.success || result.liveContentChanged !== false) {
			await invalidateRouteCache(cache, [collection, resolvedId]);
		}
		if (!unpublished.success) {
			const { code, message, details } = unpublished.error;
			return apiError(
				code,
				`The fields were saved, but the unpublish failed: ${message}`,
				mapErrorStatus(code),
				{ ...details, _rev: savedRev },
			);
		}
		// The unpublish result holds the live columns, not the draft this request saved.
		return unwrapResult(await emdash.handleContentGet(collection, resolvedId, locale));
	}

	if (result.liveContentChanged !== false) {
		await invalidateRouteCache(cache, [collection, resolvedId]);
	}

	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, locals, url, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentDelete || !emdash?.handleContentGetForWrite) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const locale = url.searchParams.get("locale") || undefined;

	const roleDenied = requirePerm(user, "content:delete_own");
	if (roleDenied) return roleDenied;

	// Fetch item to check ownership
	const existing = await emdash.handleContentGetForWrite(collection, id, locale);
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
