/**
 * Trash endpoints for content collection - injected by EmDash integration
 *
 * GET /_emdash/api/content/{collection}/trash - List trashed items
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { parseQuery, isParseError } from "#api/parse.js";
import { contentTrashQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;

	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;

	if (!emdash?.handleContentListTrashed) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const query = parseQuery(url, contentTrashQuery);
	if (isParseError(query)) return query;

	const result = await emdash.handleContentListTrashed(collection, query);

	return unwrapResult(result);
};
