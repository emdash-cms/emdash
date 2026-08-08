/**
 * Duplicate mapping endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/content/{collection}/duplicate-mapping?target={slug}&ids={csv}
 * Everything the duplicate dialog needs in one round trip.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { parseQuery } from "#api/parse.js";
import { duplicateMappingQuery } from "#api/schemas/content.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;

	if (!emdash?.handleDuplicateMappingGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:create");
	if (denied) return denied;

	const query = parseQuery(url, duplicateMappingQuery);
	if (query instanceof Response) return query;

	const ids = query.ids
		? query.ids
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id.length > 0)
		: [];

	const result = await emdash.handleDuplicateMappingGet(collection, query.target, ids);
	return unwrapResult(result);
};
