/**
 * Content-entry reference parents endpoint (child side, read-only backlink)
 *
 * GET /_emdash/api/content/:collection/:id/references/:relation/parents
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleReferenceParentsGet } from "#api/handlers/relations.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { cursorPaginationQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { collection, id, relation } = params;

	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	if (!collection || !id || !relation) {
		return apiError("VALIDATION_ERROR", "Collection, id, and relation required", 400);
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const query = parseQuery(new URL(request.url), cursorPaginationQuery);
	if (isParseError(query)) return query;

	try {
		const result = await handleReferenceParentsGet(
			emdash.db,
			collection,
			id,
			relation,
			{ limit: query.limit, cursor: query.cursor },
			hasPermission(user, "content:read_drafts"),
		);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get references", "REFERENCES_GET_ERROR");
	}
};
