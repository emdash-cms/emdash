/**
 * Content authors endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/content/{collection}/authors - List the distinct authors
 * of a collection's live content, for the admin author filter.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;

	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	if (!emdash?.handleContentAuthors) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const result = await emdash.handleContentAuthors(collection);

	return unwrapResult(result);
};
