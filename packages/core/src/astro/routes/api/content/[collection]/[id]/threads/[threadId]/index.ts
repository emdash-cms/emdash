/**
 * One editorial thread
 *
 * PATCH  /_emdash/api/content/{collection}/{id}/threads/{threadId} - Resolve or reopen
 * DELETE /_emdash/api/content/{collection}/{id}/threads/{threadId} - Delete the thread
 */

import type { APIRoute } from "astro";

import { requireEditorialPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import {
	handleEditorialThreadDelete,
	handleEditorialThreadUpdate,
} from "#api/handlers/editorial-comments.js";
import { isParseError, parseBody } from "#api/parse.js";
import { editorialThreadUpdateBody } from "#api/schemas.js";

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requireEditorialPerm(user);
	if (denied) return denied;
	const body = await parseBody(request, editorialThreadUpdateBody);
	if (isParseError(body)) return body;

	return unwrapResult(
		await handleEditorialThreadUpdate(
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
	);
};

export const DELETE: APIRoute = async ({ params, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requireEditorialPerm(user);
	if (denied) return denied;

	return unwrapResult(
		await handleEditorialThreadDelete(
			emdash.db,
			user!,
			{
				collection: params.collection!,
				id: params.id!,
				locale: url.searchParams.get("locale") || undefined,
			},
			params.threadId!,
		),
	);
};
