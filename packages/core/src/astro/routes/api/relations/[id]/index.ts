/**
 * Single relation definition endpoint
 *
 * GET    /_emdash/api/relations/:id - Get a relation
 * PATCH  /_emdash/api/relations/:id - Update a relation's labels
 * DELETE /_emdash/api/relations/:id - Delete a relation
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleRelationDelete,
	handleRelationGet,
	handleRelationUpdate,
} from "#api/handlers/relations.js";
import { isParseError, parseBody } from "#api/parse.js";
import { updateRelationBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	if (!id) return apiError("VALIDATION_ERROR", "Relation id required", 400);

	try {
		const result = await handleRelationGet(emdash.db, id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get relation", "RELATION_GET_ERROR");
	}
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	if (!id) return apiError("VALIDATION_ERROR", "Relation id required", 400);

	try {
		const body = await parseBody(request, updateRelationBody);
		if (isParseError(body)) return body;

		const result = await handleRelationUpdate(emdash.db, id, body);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update relation", "RELATION_UPDATE_ERROR");
	}
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	if (!id) return apiError("VALIDATION_ERROR", "Relation id required", 400);

	try {
		const result = await handleRelationDelete(emdash.db, id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete relation", "RELATION_DELETE_ERROR");
	}
};
