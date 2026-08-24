import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import {
	handleMediaUsageActivationAdvance,
	handleMediaUsageActivationStatus,
} from "#api/handlers/media-usage-activation.js";
import { isParseError, parseBody } from "#api/parse.js";
import { mediaUsageActivationAdvanceBody } from "#api/schemas.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;

	return unwrapResult(await handleMediaUsageActivationStatus(emdash.db));
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;

	const body = await parseBody(request, mediaUsageActivationAdvanceBody);
	if (isParseError(body)) return body;

	return unwrapResult(await handleMediaUsageActivationAdvance(emdash.db, body));
};
