/**
 * 404 log list and management endpoints
 *
 * GET    /_emdash/api/redirects/404s - List 404 log entries
 * DELETE /_emdash/api/redirects/404s - Clear all 404 log entries
 * POST   /_emdash/api/redirects/404s - Prune 404 log entries older than date
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleNotFoundClear,
	handleNotFoundList,
	handleNotFoundPrune,
} from "#api/handlers/redirects.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { notFoundListQuery, notFoundPruneBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;

	const denied = requirePerm(user, "redirects:read");
	if (denied) return denied;

	try {
		const query = parseQuery(url, notFoundListQuery);
		if (isParseError(query)) return query;

		const result = await handleNotFoundList(db, query);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to fetch 404 log", "NOT_FOUND_LIST_ERROR");
	}
};

export const DELETE: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;

	const denied = requirePerm(user, "redirects:manage");
	if (denied) return denied;

	try {
		const result = await handleNotFoundClear(db);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to clear 404 log", "NOT_FOUND_CLEAR_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;

	const denied = requirePerm(user, "redirects:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, notFoundPruneBody);
		if (isParseError(body)) return body;

		const result = await handleNotFoundPrune(db, body.olderThan);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to prune 404 log", "NOT_FOUND_PRUNE_ERROR");
	}
};
