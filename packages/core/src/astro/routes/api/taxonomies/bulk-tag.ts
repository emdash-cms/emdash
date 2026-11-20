import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleBulkTag } from "#api/handlers/bulk-tag.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { bulkTagBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ locals, request, cache }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:edit_any");
	if (denied) return denied;
	const body = await parseBody(request, bulkTagBody);
	if (isParseError(body)) return body;
	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	return unwrapResult(
		await handleBulkTag(
			emdash.db,
			getPublicOrigin(new URL(request.url), emdash.config),
			body,
			cache?.enabled ? (tags) => cache.invalidate({ tags }) : undefined,
		),
	);
};
