/**
 * 404 summary endpoint
 *
 * GET /_emdash/api/redirects/404s/summary - Get 404 summary grouped by path
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleNotFoundSummary } from "#api/handlers/redirects.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { notFoundSummaryQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;

	const denied = requirePerm(user, "redirects:read");
	if (denied) return denied;

	try {
		const query = parseQuery(url, notFoundSummaryQuery);
		if (isParseError(query)) return query;

		const result = await handleNotFoundSummary(db, query.limit);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to fetch 404 summary", "NOT_FOUND_SUMMARY_ERROR");
	}
};
