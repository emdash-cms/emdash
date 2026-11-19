/**
 * Orphaned tables discovery endpoint
 *
 * GET  /_emdash/api/schema/orphans - List orphaned content tables
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleOrphanedTableList } from "#api/index.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const result = await handleOrphanedTableList(emdash.db);
	return unwrapResult(result);
};
