/**
 * Single taxonomy definition endpoint
 *
 * GET    /_emdash/api/taxonomies/:name - Get a taxonomy definition
 * PUT    /_emdash/api/taxonomies/:name - Update a taxonomy definition
 * DELETE /_emdash/api/taxonomies/:name - Delete a taxonomy definition
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleTaxonomyGet,
	handleTaxonomyUpdate,
	handleTaxonomyDelete,
} from "#api/handlers/taxonomies.js";
import { isParseError, parseBody } from "#api/parse.js";
import { updateTaxonomyDefBody } from "#api/schemas.js";

export const prerender = false;

/**
 * Get a taxonomy definition by name
 */
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:read");
	if (denied) return denied;

	const name = params.name!;

	try {
		const result = await handleTaxonomyGet(emdash.db, name);
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

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	const name = params.name!;

	try {
		const body = await parseBody(request, updateTaxonomyDefBody);
		if (isParseError(body)) return body;

		const result = await handleTaxonomyUpdate(emdash.db, name, body);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update taxonomy", "TAXONOMY_UPDATE_ERROR");
	}
};

/**
 * Delete a taxonomy definition and all its terms
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	const name = params.name!;

	try {
		const result = await handleTaxonomyDelete(emdash.db, name);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete taxonomy", "TAXONOMY_DELETE_ERROR");
	}
};
