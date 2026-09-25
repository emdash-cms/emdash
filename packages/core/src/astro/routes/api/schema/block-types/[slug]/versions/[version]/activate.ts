import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleBlockTypeVersionActivate } from "#api/index.js";
import { isParseError, parseBody } from "#api/parse.js";
import { activateBlockTypeVersionBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const dbError = requireDb(emdash?.db);
	if (dbError) return dbError;
	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const version = Number(params.version);
	if (!Number.isInteger(version) || version < 1) {
		return apiError("INVALID_INPUT", "Block type version must be a positive integer", 400);
	}
	const body = await parseBody(request, activateBlockTypeVersionBody);
	if (isParseError(body)) return body;
	return unwrapResult(
		await handleBlockTypeVersionActivate(
			emdash.db,
			params.slug!,
			version,
			body.expectedFingerprint,
		),
	);
};
