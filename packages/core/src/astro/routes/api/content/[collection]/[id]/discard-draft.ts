/**
 * Discard draft changes - reverts to live version
 *
 * POST /_emdash/api/content/{collection}/{id}/discard-draft
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
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

	if (!emdash?.handleContentDiscardDraft || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const body = await parseOptionalBody(request, contentRevisionConditionBody, {});
	if (isParseError(body)) return body;

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
	const existingItem = existing.data.item;
	const authorId = existingItem.authorId ?? "";
	const denied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
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

	const result = await emdash.handleContentDiscardDraft(collection, resolvedId, {
		_rev: body?._rev,
		actor: { id: user!.id, role: user!.role },
	});

	if (!result.success) return unwrapResult(result);

	await invalidateRouteCache(cache, [collection, resolvedId]);

	return unwrapResult(result);
};
