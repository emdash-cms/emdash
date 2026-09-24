/**
 * GET /_emdash/api/admin/transfer/imports/:id/plan — the analyzed plan and its digest.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleImportPlan } from "#api/handlers/transfer.js";
import { requireAnyScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireAnyScope(locals, ["transfer:analyze", "transfer:execute"]);
	if (scopeDenied) return scopeDenied;

	if (!emdash.storage) {
		return apiError("STORAGE_NOT_CONFIGURED", "No storage backend is configured", 503);
	}

	return unwrapResult(await handleImportPlan(emdash.db, emdash.storage, params.id ?? ""));
};
