/**
 * GET /_emdash/api/admin/transfer/approvals
 *
 * Transfer approval grants requested by MCP callers, newest first. Signed-in
 * sessions only: bearer tokens are refused.
 */

import type { APIRoute } from "astro";

import { requireAnyPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleApprovalList } from "#api/handlers/transfer.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { transferApprovalListQuery } from "#api/schemas/transfer.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requireAnyPerm(user, ["transfer:export", "transfer:import"]);
	if (denied) return denied;
	if (locals.tokenScopes !== undefined) {
		return apiError("FORBIDDEN", "Transfer approvals require a signed-in session", 403);
	}

	const query = parseQuery(url, transferApprovalListQuery);
	if (isParseError(query)) return query;

	return unwrapResult(await handleApprovalList(emdash.db, query));
};
