/**
 * Redirect by ID endpoints
 *
 * GET    /_emdash/api/redirects/:id - Get redirect
 * PUT    /_emdash/api/redirects/:id - Update redirect
 * DELETE /_emdash/api/redirects/:id - Delete redirect
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleRedirectDelete,
	handleRedirectGet,
	handleRedirectUpdate,
} from "#api/handlers/redirects.js";
import { isParseError, parseBody } from "#api/parse.js";
import { updateRedirectBody } from "#api/schemas.js";
import { invalidateRedirectCache } from "#redirects/cache.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;
	const { id } = params;

	const denied = requirePerm(user, "redirects:read");
	if (denied) return denied;

	if (!id) {
		return apiError("VALIDATION_ERROR", "id is required", 400);
	}

	try {
		const result = await handleRedirectGet(db, id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to fetch redirect", "REDIRECT_GET_ERROR");
	}
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;
	const { id } = params;

	const denied = requirePerm(user, "redirects:manage");
	if (denied) return denied;

	if (!id) {
		return apiError("VALIDATION_ERROR", "id is required", 400);
	}

	try {
		const body = await parseBody(request, updateRedirectBody);
		if (isParseError(body)) return body;

		const result = await handleRedirectUpdate(db, id, body);
		invalidateRedirectCache();
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update redirect", "REDIRECT_UPDATE_ERROR");
	}
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;
	const { id } = params;

	const denied = requirePerm(user, "redirects:manage");
	if (denied) return denied;

	if (!id) {
		return apiError("VALIDATION_ERROR", "id is required", 400);
	}

	try {
		const result = await handleRedirectDelete(db, id);
		invalidateRedirectCache();
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete redirect", "REDIRECT_DELETE_ERROR");
	}
};
