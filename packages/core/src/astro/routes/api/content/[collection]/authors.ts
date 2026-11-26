/**
 * Content authors endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/content/{collection}/authors - List the distinct authors
 * of a collection's live content, for the admin author filter.
 */

import type { APIRoute } from "astro";

import { canReadUserEmails, requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;

	// Editorial capability, not plain read. This response reveals the authors
	// of unpublished entries, so it must not be reachable by subscribers
	// (content:read). content:read_drafts is the same tier the list route
	// requires before it stops forcing status=published, so the visibility
	// surfaces line up.
	if (!emdash?.handleContentAuthors) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;

	// Email addresses are account data, readable only with users:read.
	const result = await emdash.handleContentAuthors(collection, {
		includeEmail: canReadUserEmails(user, locals.tokenScopes),
	});

	return unwrapResult(result);
};
