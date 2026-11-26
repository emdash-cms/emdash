/**
 * Unpublish content - removes from public view, preserves draft
 *
 * POST /_emdash/api/content/{collection}/{id}/unpublish
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { claimEntryLockForWrite } from "#api/handlers/entry-lock.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { contentRevisionConditionBody } from "#api/schemas.js";
import { invalidateRouteCache } from "#cache/route-cache.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, url, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentUnpublish || !emdash?.handleContentGetForWrite) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const body = await parseOptionalBody(request, contentRevisionConditionBody, {});
	if (isParseError(body)) return body;

	const locale = url.searchParams.get("locale") || undefined;

	const roleDenied = requirePerm(user, "content:publish_own");
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

	const existingItem = existing.data.item;
	const authorId = existingItem.authorId ?? "";
	const denied = requireOwnerPerm(user, authorId, "content:publish_own", "content:publish_any");
	if (denied) return denied;

	const resolvedId = existingItem.id;

	const refusal = await claimEntryLockForWrite(emdash.db, collection, resolvedId, user!.id, {
		override: body?.overrideLock,
	});
	if (refusal) {
		return apiError(refusal.code, refusal.message, mapErrorStatus(refusal.code), {
			...refusal.details,
		});
	}

	const result = await emdash.handleContentUnpublish(collection, resolvedId, {
		_rev: body?._rev,
		actor: { id: user!.id, role: user!.role },
		origin: { source: "api" },
	});

	if (!result.success) return unwrapResult(result);

	await invalidateRouteCache(cache, [collection, resolvedId]);

	return unwrapResult(result);
};
