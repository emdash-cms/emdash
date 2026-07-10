/**
 * Register orphaned table endpoint
 *
 * POST /_emdash/api/schema/orphans/:slug - Register an orphaned table as a collection
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleOrphanedTableRegister } from "#api/index.js";
import { parseOptionalBody, isParseError } from "#api/parse.js";
import { orphanRegisterBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const slug = params.slug;
	if (!slug) {
		return apiError("VALIDATION_ERROR", "Slug is required", 400);
	}

	const options = await parseOptionalBody(request, orphanRegisterBody, {});
	if (isParseError(options)) return options;

	const result = await handleOrphanedTableRegister(emdash.db, slug, options);
	return unwrapResult(result, 201);
};
