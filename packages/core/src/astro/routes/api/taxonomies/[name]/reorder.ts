/**
 * Taxonomy term reorder endpoint
 *
 * POST /_emdash/api/taxonomies/:name/reorder
 *   body: { parentId?, ids }
 *
 * Sets the manual order of one sibling group. There is no `locale`: a term
 * holds one position across every locale it is translated into.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleTermReorder } from "#api/handlers/taxonomies.js";
import { isParseError, parseBody } from "#api/parse.js";
import { reorderTermsBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name } = params;
	if (!name) return apiError("VALIDATION_ERROR", "Taxonomy name required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, reorderTermsBody);
		if (isParseError(body)) return body;

		const result = await handleTermReorder(emdash.db, name, body);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to reorder terms", "TERM_REORDER_ERROR");
	}
};
