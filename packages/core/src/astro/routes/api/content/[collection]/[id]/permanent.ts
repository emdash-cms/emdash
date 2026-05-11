/**
 * Permanent delete content endpoint - injected by EmDash integration
 *
 * DELETE /_emdash/api/content/{collection}/{id}/permanent - Permanently delete (no undo)
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";

export const prerender = false;

export const DELETE: APIRoute = async ({ params, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	const denied = requirePerm(user, "content:delete_permanent");
	if (denied) return denied;

	if (!emdash?.handleContentPermanentDelete) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const result = await emdash.handleContentPermanentDelete(collection, id);

	if (!result.success) return unwrapResult(result);

	if (cache?.enabled) await cache.invalidate({ tags: [collection, id] });

	return unwrapResult(result);
};
