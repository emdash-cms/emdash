/**
 * Replies on an editorial thread
 *
 * POST /_emdash/api/content/{collection}/{id}/threads/{threadId}/comments - Reply
 */

import type { APIRoute } from "astro";

import { requireEditorialPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleEditorialCommentCreate } from "#api/handlers/editorial-comments.js";
import { isParseError, parseBody } from "#api/parse.js";
import { editorialCommentBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requireEditorialPerm(user);
	if (denied) return denied;
	const body = await parseBody(request, editorialCommentBody);
	if (isParseError(body)) return body;

	return unwrapResult(
		await handleEditorialCommentCreate(
			emdash.db,
			user!,
			{
				collection: params.collection!,
				id: params.id!,
				locale: url.searchParams.get("locale") || undefined,
			},
			params.threadId!,
			body,
		),
		201,
	);
};
