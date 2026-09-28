import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleBlockTypeCreate, handleBlockTypeList } from "#api/index.js";
import { isParseError, parseBody } from "#api/parse.js";
import { createBlockTypeBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	const dbError = requireDb(emdash?.db);
	if (dbError) return dbError;
	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;
	return unwrapResult(await handleBlockTypeList(emdash.db));
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const dbError = requireDb(emdash?.db);
	if (dbError) return dbError;
	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const body = await parseBody(request, createBlockTypeBody);
	if (isParseError(body)) return body;
	return unwrapResult(await handleBlockTypeCreate(emdash.db, body), 201);
};
