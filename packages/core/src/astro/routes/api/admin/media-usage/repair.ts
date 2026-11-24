import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMediaUsageRepair } from "#api/handlers/media-usage.js";
import { isParseError, parseBody } from "#api/parse.js";
import { mediaUsageRepairBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, mediaUsageRepairBody);
	if (isParseError(body)) return body;

	const result = await handleMediaUsageRepair(emdash.db, body);
	return unwrapResult(result);
};
