import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMediaUsageWorkList } from "#api/handlers/media-usage-work.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { mediaUsageWorkListQuery } from "#api/schemas.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;

	const query = parseQuery(new URL(request.url), mediaUsageWorkListQuery);
	if (isParseError(query)) return query;

	return unwrapResult(await handleMediaUsageWorkList(emdash.db, query));
};
