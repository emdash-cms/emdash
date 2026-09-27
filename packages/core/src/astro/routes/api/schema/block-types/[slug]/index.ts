import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleBlockTypeGet, handleBlockTypeUpdate } from "#api/index.js";
import { isParseError, parseBody } from "#api/parse.js";
import { updateBlockTypeBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const dbError = requireDb(emdash?.db);
	if (dbError) return dbError;
	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;
	return unwrapResult(await handleBlockTypeGet(emdash.db, params.slug!));
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const dbError = requireDb(emdash?.db);
	if (dbError) return dbError;
	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const body = await parseBody(request, updateBlockTypeBody);
	if (isParseError(body)) return body;
	return unwrapResult(await handleBlockTypeUpdate(emdash.db, params.slug!, body));
};
