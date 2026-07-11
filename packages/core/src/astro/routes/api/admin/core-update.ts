/**
 * Core update status endpoint (Discussion #1889)
 *
 * GET /_emdash/api/admin/core-update - Cached "is a newer EmDash
 * version available?" status for the admin dashboard banner. Serves
 * the options-table cache and defers the (at most daily) npm registry
 * refresh via `after()`, so it never blocks on the network.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleCoreUpdateStatus } from "#api/handlers/update-check.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "updates:read");
	if (denied) return denied;

	const result = await handleCoreUpdateStatus(emdash.db, {
		enabled: emdash.config.updateCheck !== false,
	});
	return unwrapResult(result);
};
