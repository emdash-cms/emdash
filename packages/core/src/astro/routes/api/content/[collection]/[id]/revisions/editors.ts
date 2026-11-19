/**
 * Revision editors endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/content/{collection}/{id}/revisions/editors?since={revisionId} - List everyone
 * who edited the entry in the revisions newer than `since`
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.handleRevisionEditors) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;

	const result = await emdash.handleRevisionEditors(
		params.collection!,
		params.id!,
		url.searchParams.get("since") || null,
	);

	return unwrapResult(result);
};
