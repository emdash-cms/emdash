/**
 * Users who can be mentioned on an entry's editorial threads
 *
 * GET /_emdash/api/content/{collection}/{id}/threads/mentionable?q= - Up to 10 users by name
 */

import type { APIRoute } from "astro";

import { requireEditorialPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleEditorialMentionable } from "#api/handlers/editorial-comments.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { editorialMentionableQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requireEditorialPerm(user);
	if (denied) return denied;
	const query = parseQuery(url, editorialMentionableQuery);
	if (isParseError(query)) return query;

	return unwrapResult(
		await handleEditorialMentionable(
			emdash.db,
			{
				collection: params.collection!,
				id: params.id!,
				locale: url.searchParams.get("locale") || undefined,
			},
			query.q,
		),
	);
};
