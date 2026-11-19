import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMediaUsageCollectionDeletionRetry } from "#api/handlers/media-usage-work.js";
import { isParseError, parseBody } from "#api/parse.js";
import { mediaUsageCollectionDeletionRetryBody } from "#api/schemas.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(locals.user, "schema:manage");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;
	const body = await parseBody(request, mediaUsageCollectionDeletionRetryBody);
	if (isParseError(body)) return body;
	return unwrapResult(await handleMediaUsageCollectionDeletionRetry(locals.emdash.db, body));
};
