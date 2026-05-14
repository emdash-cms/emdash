/**
 * Menu sync endpoints
 *
 * GET  /_emdash/api/menus/:name/sync-diff  - Preview sync changes
 * POST /_emdash/api/menus/:name/sync       - Apply sync changes
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { computeMenuSyncDiff, syncSidebarToMenu } from "#api/index.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const name = params.name;

	if (!name) {
		return unwrapResult({
			success: false,
			error: { code: "MISSING_PARAM", message: "Menu name is required" },
		});
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	const result = await computeMenuSyncDiff(emdash!.db, name);
	return unwrapResult(result);
};

export const POST: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const name = params.name;

	if (!name) {
		return unwrapResult({
			success: false,
			error: { code: "MISSING_PARAM", message: "Menu name is required" },
		});
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	const result = await syncSidebarToMenu(emdash!.db, name);
	return unwrapResult(result);
};
