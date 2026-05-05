/**
 * Taxonomy definitions endpoint
 *
 * GET  /_emdash/api/taxonomies[?locale=xx] - List taxonomy definitions
 * POST /_emdash/api/taxonomies              - Create a custom taxonomy definition
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleTaxonomyCreate, handleTaxonomyList } from "#api/handlers/taxonomies.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { createTaxonomyDefBody, localeFilterQuery } from "#api/schemas.js";

export const prerender = false;

/**
 * List taxonomy definitions
 */
export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:read");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const result = await handleTaxonomyList(emdash.db, { locale: query.locale });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to list taxonomies", "TAXONOMY_LIST_ERROR");
	}
};

/**
 * Create a custom taxonomy definition
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createTaxonomyDefBody);
		if (isParseError(body)) return body;

		const result = await handleTaxonomyCreate(emdash.db, body);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create taxonomy", "TAXONOMY_CREATE_ERROR");
	}
};
