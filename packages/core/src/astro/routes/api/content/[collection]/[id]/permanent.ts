/**
 * Permanent delete content endpoint - injected by EmDash integration
 *
 * DELETE /_emdash/api/content/{collection}/{id}/permanent - Permanently delete (no undo)
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { invalidateRouteCache } from "#cache/route-cache.js";

export const prerender = false;

export const DELETE: APIRoute = async ({ params, locals, cache, url }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentPermanentDelete || !emdash?.handleContentGetForWrite) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:delete_permanent");
	if (denied) return denied;

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
	const resolvedId = existing.data.item.id;

	const result = await emdash.handleContentPermanentDelete(collection, resolvedId);

	if (!result.success) return unwrapResult(result);

	await invalidateRouteCache(cache, [collection, resolvedId]);

	return unwrapResult(result);
};
