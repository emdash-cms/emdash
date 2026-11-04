import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMediaFolderCreate, handleMediaFolderList } from "#api/handlers/media-folders.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { mediaFolderBody, mediaFolderListQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "media:read");
	if (denied) return denied;
	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const query = parseQuery(new URL(request.url), mediaFolderListQuery);
	if (isParseError(query)) return query;
	return unwrapResult(
		await handleMediaFolderList(emdash.db, {
			limit: query.limit,
			cursor: query.cursor,
			q: query.q,
		}),
	);
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "media:edit_any");
	if (denied) return denied;
	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const body = await parseBody(request, mediaFolderBody);
	if (isParseError(body)) return body;
	return unwrapResult(await handleMediaFolderCreate(emdash.db, body), 201);
};
