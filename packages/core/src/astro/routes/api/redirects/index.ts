/**
 * Redirects list and create endpoints
 *
 * GET  /_emdash/api/redirects - List redirects (with filters)
 * POST /_emdash/api/redirects - Create redirect
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, unwrapResult } from "#api/error.js";
import { handleRedirectCreate, handleRedirectList } from "#api/handlers/redirects.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { createRedirectBody, redirectsListQuery } from "#api/schemas.js";
import { invalidateRedirectCache } from "#redirects/cache.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;

	const denied = requirePerm(user, "redirects:read");
	if (denied) return denied;

	try {
		const query = parseQuery(url, redirectsListQuery);
		if (isParseError(query)) return query;

		const result = await handleRedirectList(db, query);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to fetch redirects", "REDIRECT_LIST_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const db = emdash.db;

	const denied = requirePerm(user, "redirects:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createRedirectBody);
		if (isParseError(body)) return body;

		const result = await handleRedirectCreate(db, body);
		invalidateRedirectCache();
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create redirect", "REDIRECT_CREATE_ERROR");
	}
};
