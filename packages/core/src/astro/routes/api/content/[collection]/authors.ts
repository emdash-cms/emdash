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

	// Editorial capability, not plain read. This response carries author
	// emails (PII) and reveals the authors of unpublished entries, so it must
	// not be reachable by subscribers (content:read). content:read_drafts is
	// the same tier the list route requires before it stops forcing
	// status=published, so the visibility surfaces line up.
	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;

	if (!emdash?.handleContentAuthors) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const result = await emdash.handleContentAuthors(collection);

	return unwrapResult(result);
};
