/**
 * Editorial thread anchors
 *
 * PATCH /_emdash/api/content/{collection}/{id}/threads/anchors - Store recomputed anchors
 */

import type { APIRoute } from "astro";

import { requireEditorialPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleEditorialAnchorsUpdate } from "#api/handlers/editorial-comments.js";
import { isParseError, parseBody } from "#api/parse.js";
import { editorialAnchorsUpdateBody } from "#api/schemas.js";

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requireEditorialPerm(user);
	if (denied) return denied;
	const body = await parseBody(request, editorialAnchorsUpdateBody);
	if (isParseError(body)) return body;

	return unwrapResult(
		await handleEditorialAnchorsUpdate(
			emdash.db,
			{
				collection: params.collection!,
				id: params.id!,
				locale: url.searchParams.get("locale") || undefined,
			},
			body,
		),
	);
};
