/**
 * Editorial threads on an entry
 *
 * GET  /_emdash/api/content/{collection}/{id}/threads - List the entry's threads
 * POST /_emdash/api/content/{collection}/{id}/threads - Start a thread
 */

import type { APIRoute } from "astro";

import { requireEditorialPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import {
	handleEditorialThreadCreate,
	handleEditorialThreadList,
} from "#api/handlers/editorial-comments.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { editorialThreadCreateBody, editorialThreadListQuery } from "#api/schemas.js";

import { queueEditorialCommentNotifications } from "../../../../../../../editorial/notifications.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requireEditorialPerm(user);
	if (denied) return denied;
	const query = parseQuery(url, editorialThreadListQuery);
	if (isParseError(query)) return query;

	return unwrapResult(
		await handleEditorialThreadList(
			emdash.db,
			user!,
			{
				collection: params.collection!,
				id: params.id!,
				locale: url.searchParams.get("locale") || undefined,
			},
			query,
		),
	);
};

export const POST: APIRoute = async ({ params, request, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requireEditorialPerm(user);
	if (denied) return denied;
	const body = await parseBody(request, editorialThreadCreateBody);
	if (isParseError(body)) return body;

	return unwrapResult(
		await handleEditorialThreadCreate(
			emdash.db,
			user!,
			{
				collection: params.collection!,
				id: params.id!,
				locale: url.searchParams.get("locale") || undefined,
			},
			body,
			(created) =>
				queueEditorialCommentNotifications(
					{ db: emdash.db, email: emdash.email, request, config: emdash.config },
					created,
				),
		),
		201,
	);
};
