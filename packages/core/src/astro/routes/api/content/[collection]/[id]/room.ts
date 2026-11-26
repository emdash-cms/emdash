/**
 * Co-editing room
 *
 * POST /_emdash/api/content/{collection}/{id}/room - Join the entry's room
 *
 * A client given a room opens its WebSocket on this path, with `?token=`.
 */

import type { APIRoute } from "astro";

import { apiError, unwrapResult } from "#api/error.js";
import { handleRoomJoin } from "#api/handlers/rooms.js";
import { isParseError, parseBody } from "#api/parse.js";
import { roomJoinBody } from "#api/schemas.js";

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;

export const POST: APIRoute = async ({ params, request, locals, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (locals.tokenScopes !== undefined) {
		return apiError("FORBIDDEN", "Joining a room requires a signed-in session", 403);
	}
	const body = await parseBody(request, roomJoinBody);
	if (isParseError(body)) return body;

	return unwrapResult(
		await handleRoomJoin(emdash.db, emdash.rooms, {
			collection: params.collection!,
			id: params.id!,
			locale: url.searchParams.get("locale") || undefined,
			user,
			body,
			getManifest: () => emdash.getManifest(),
			playground: locals.__playgroundDb !== undefined,
			basePath: import.meta.env.BASE_URL.replace(TRAILING_SLASH_RE, ""),
		}),
	);
};
