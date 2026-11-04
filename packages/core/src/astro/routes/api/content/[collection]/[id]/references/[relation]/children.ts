/**
 * Content-entry reference children endpoint (parent side), read-only.
 *
 * GET /_emdash/api/content/:collection/:id/references/:relation/children
 *
 * A selection is written with the entry that holds it, through the `references`
 * key of the content create and update bodies. Writing edges here instead would
 * put them live on a collection that keeps drafts, past staging, discard and
 * publication.
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleReferenceChildrenGet } from "#api/handlers/relations.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { cursorPaginationQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { collection, id, relation } = params;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	if (!collection || !id || !relation) {
		return apiError("VALIDATION_ERROR", "Collection, id, and relation required", 400);
	}

	const query = parseQuery(new URL(request.url), cursorPaginationQuery);
	if (isParseError(query)) return query;

	try {
		const result = await handleReferenceChildrenGet(
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
