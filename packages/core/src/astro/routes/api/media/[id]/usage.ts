import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMediaUsageDetails } from "#api/handlers/media-usage.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { mediaUsageDetailsQuery } from "#api/schemas.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;

	const mediaDenied = requirePerm(user, "media:read");
	if (mediaDenied) return mediaDenied;
	const contentDenied = requirePerm(user, "content:read_drafts");
	if (contentDenied) return contentDenied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;

	const { id } = params;
	if (!id) return apiError("INVALID_REQUEST", "Media ID required", 400);
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const query = parseQuery(new URL(request.url), mediaUsageDetailsQuery);
	if (isParseError(query)) return query;

	return unwrapResult(await handleMediaUsageDetails(emdash.db, id, query));
};
