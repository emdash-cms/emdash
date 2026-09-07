/**
 * Single taxonomy definition endpoint
 *
 * GET    /_emdash/api/taxonomies/:name[?locale=xx]
 * PUT    /_emdash/api/taxonomies/:name[?locale=xx]
 * DELETE /_emdash/api/taxonomies/:name
 *
 * GET and PUT address one locale's definition. DELETE takes no locale — it
 * removes the taxonomy outright, terms and assignments included.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleTaxonomyDelete,
	handleTaxonomyGet,
	handleTaxonomyUpdate,
} from "#api/handlers/taxonomies.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { localeFilterQuery, updateTaxonomyDefBody } from "#api/schemas.js";

export const prerender = false;

/**
 * Get a single taxonomy definition
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
		const result = await handleTaxonomyGet(emdash.db, name, { locale: query.locale });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get taxonomy", "TAXONOMY_GET_ERROR");
	}
};

/**
 * Update a taxonomy definition
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name } = params;
	if (!name) return apiError("VALIDATION_ERROR", "Taxonomy name required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const body = await parseBody(request, updateTaxonomyDefBody);
		if (isParseError(body)) return body;

		const result = await handleTaxonomyUpdate(emdash.db, name, {
			...body,
			locale: query.locale,
		});
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update taxonomy", "TAXONOMY_UPDATE_ERROR");
	}
};

/**
 * Delete a taxonomy, its terms, and their content assignments
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { name } = params;
	if (!name) return apiError("VALIDATION_ERROR", "Taxonomy name required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	try {
		const result = await handleTaxonomyDelete(emdash.db, name);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete taxonomy", "TAXONOMY_DELETE_ERROR");
	}
};
