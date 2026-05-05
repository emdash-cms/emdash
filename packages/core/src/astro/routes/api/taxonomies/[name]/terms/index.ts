/**
 * Taxonomy terms list and create endpoint
 *
 * GET  /_emdash/api/taxonomies/:name/terms[?locale=xx] - List terms (tree for hierarchical)
 * POST /_emdash/api/taxonomies/:name/terms              - Create a new term (body may include locale & translationOf)
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleTermCreate, handleTermList } from "#api/handlers/taxonomies.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { createTermBody, localeFilterQuery } from "#api/schemas.js";

export const prerender = false;

/**
 * List all terms for a taxonomy
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name } = params;
	if (!name) return apiError("VALIDATION_ERROR", "Taxonomy name required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:read");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const result = await handleTermList(emdash.db, name, { locale: query.locale });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to list terms", "TERM_LIST_ERROR");
	}
};

/**
 * Create a new term
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name } = params;
	if (!name) return apiError("VALIDATION_ERROR", "Taxonomy name required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createTermBody);
		if (isParseError(body)) return body;

		const result = await handleTermCreate(emdash.db, name, body);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create term", "TERM_CREATE_ERROR");
	}
};
