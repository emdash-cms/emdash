/**
 * Admin sidebar navigation config
 *
 * GET /_emdash/api/admin/navigation — read the stored sidebar IA config.
 * PUT /_emdash/api/admin/navigation — replace the stored sidebar IA config.
 *
 * Grouping/hiding is presentation only: hiding an item never affects
 * routing or authorization. Normal sidebar rendering reads the config from
 * the manifest; these endpoints exist for the settings organizer.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { getAdminNavigation, setAdminNavigation } from "#api/handlers/admin-navigation.js";
import { isParseError, parseBody } from "#api/parse.js";
import { adminNavigationConfigSchema } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	return unwrapResult(await getAdminNavigation(emdash.db));
};

export const PUT: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const body = await parseBody(request, adminNavigationConfigSchema);
	if (isParseError(body)) return body;

	return unwrapResult(await setAdminNavigation(emdash.db, body));
};
