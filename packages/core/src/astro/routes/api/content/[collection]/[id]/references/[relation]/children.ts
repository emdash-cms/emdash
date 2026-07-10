/**
 * Content-entry reference children endpoint (parent side)
 *
 * GET  /_emdash/api/content/:collection/:id/references/:relation/children
 * POST /_emdash/api/content/:collection/:id/references/:relation/children
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleReferenceChildrenGet, handleReferenceChildrenSet } from "#api/handlers/relations.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { cursorPaginationQuery, setReferenceChildrenBody } from "#api/schemas.js";
import { ContentRepository } from "#db/repositories/content.js";

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

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { collection, id, relation } = params;

	if (!collection || !id || !relation) {
		return apiError("VALIDATION_ERROR", "Collection, id, and relation required", 400);
	}

	// Gate on the base edit capability BEFORE the existence lookup. Resolving the
	// entry first would let a user with no edit permission distinguish real ids
	// (403) from missing ids (404) — an existence oracle. Mirrors the taxonomy
	// edge POST, which checks `content:edit_own` before fetching the entry.
	const denied = requirePerm(user, "content:edit_own");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	// Resolve the parent entry to gate on its author (ownership-aware write).
	const parent = await new ContentRepository(emdash.db).findByIdOrSlug(collection, id);
	if (!parent) return apiError("NOT_FOUND", "Content not found", 404);

	const editDenied = requireOwnerPerm(
		user,
		parent.authorId ?? "",
		"content:edit_own",
		"content:edit_any",
	);
	if (editDenied) return editDenied;

	try {
		const body = await parseBody(request, setReferenceChildrenBody);
		if (isParseError(body)) return body;

		const result = await handleReferenceChildrenSet(
			emdash.db,
			collection,
			id,
			relation,
			body.childIds,
		);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to set references", "REFERENCES_SET_ERROR");
	}
};
