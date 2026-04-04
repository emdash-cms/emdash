/**
 * Single role definition endpoint
 *
 * GET    /_emdash/api/roles/:name - Get a role definition
 * PUT    /_emdash/api/roles/:name - Update a role definition
 * DELETE /_emdash/api/roles/:name - Delete a role definition
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleRoleGet,
	handleRoleUpdate,
	handleRoleDelete,
} from "#api/handlers/roles.js";
import { isParseError, parseBody } from "#api/parse.js";
import { updateRoleBody } from "#api/schemas.js";

export const prerender = false;

/**
 * Get a role definition by name
 */
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "users:read");
	if (denied) return denied;

	const name = params.name!;

	try {
		const result = await handleRoleGet(emdash.db, name);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get role", "ROLE_GET_ERROR");
	}
};

/**
 * Update a role definition
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "users:manage");
	if (denied) return denied;

	const name = params.name!;

	try {
		const body = await parseBody(request, updateRoleBody);
		if (isParseError(body)) return body;

		const result = await handleRoleUpdate(emdash.db, name, body);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update role", "ROLE_UPDATE_ERROR");
	}
};

/**
 * Delete a custom role definition
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "users:manage");
	if (denied) return denied;

	const name = params.name!;

	try {
		const result = await handleRoleDelete(emdash.db, name);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete role", "ROLE_DELETE_ERROR");
	}
};
