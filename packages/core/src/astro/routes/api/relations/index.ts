/**
 * Relation definitions endpoint
 *
 * GET  /_emdash/api/relations[?locale=xx] - List relation definitions
 * POST /_emdash/api/relations              - Create a relation definition
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleRelationCreate, handleRelationList } from "#api/handlers/relations.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { createRelationBody, localeFilterQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const result = await handleRelationList(emdash.db, { locale: query.locale });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to list relations", "RELATION_LIST_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createRelationBody);
		if (isParseError(body)) return body;

		const result = await handleRelationCreate(emdash.db, body);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create relation", "RELATION_CREATE_ERROR");
	}
};
