/**
 * Restore content from trash endpoint - injected by EmDash integration
 *
 * POST /_emdash/api/content/{collection}/{id}/restore - Restore from trash
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { invalidateRouteCache } from "#cache/route-cache.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals, cache, url }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentRestore || !emdash?.handleContentGetForWrite) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const roleDenied = requirePerm(user, "content:edit_own");
	if (roleDenied) return roleDenied;

	// Fetch item including trashed items to check ownership
	const locale = url.searchParams.get("locale") || undefined;
	const existing = await emdash.handleContentGetForWrite(collection, id, locale, {
		includeTrashed: true,
	});
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}
	const existingItem = existing.data.item;
	const denied = requireOwnerPerm(
		user,
		existingItem.authorId ?? "",
		"content:edit_own",
		"content:edit_any",
	);
	if (denied) return denied;

	const resolvedId = existingItem.id;

	const result = await emdash.handleContentRestore(collection, resolvedId);

	if (!result.success) return unwrapResult(result);

	await invalidateRouteCache(cache, [collection, resolvedId]);

	return unwrapResult(result);
};
