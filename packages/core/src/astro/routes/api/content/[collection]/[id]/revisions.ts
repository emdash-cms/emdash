/**
 * Revisions API endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/content/{collection}/{id}/revisions - List revisions
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleRevisionList) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const limit = url.searchParams.get("limit");
	const result = await emdash.handleRevisionList(collection, id, {
		limit: limit ? parseInt(limit, 10) : undefined,
	});

	return unwrapResult(result);
};
