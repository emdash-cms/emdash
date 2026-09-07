import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleMediaUsageCollectionDeletionList } from "#api/handlers/media-usage-work.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { mediaUsageCollectionDeletionListQuery } from "#api/schemas.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	const dbErr = requireDb(locals.emdash?.db);
	if (dbErr) return dbErr;
	const denied = requirePerm(locals.user, "schema:manage");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;
	const query = parseQuery(new URL(request.url), mediaUsageCollectionDeletionListQuery);
	if (isParseError(query)) return query;
	return unwrapResult(await handleMediaUsageCollectionDeletionList(locals.emdash.db, query));
};
