/**
 * Role definitions endpoint
 *
 * GET  /_emdash/api/roles - List all role definitions
 * POST /_emdash/api/roles - Create a custom role definition
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleRoleCreate, handleRoleList } from "#api/handlers/roles.js";
import { isParseError, parseBody } from "#api/parse.js";
import { createRoleBody } from "#api/schemas.js";

export const prerender = false;

/**
 * List all role definitions (built-in + custom)
 */
export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "users:read");
	if (denied) return denied;

	try {
		const result = await handleRoleList(emdash.db);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to list roles", "ROLE_LIST_ERROR");
	}
};

/**
 * Create a custom role definition
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "users:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createRoleBody);
		if (isParseError(body)) return body;

		const result = await handleRoleCreate(emdash.db, body);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create role", "ROLE_CREATE_ERROR");
	}
};
