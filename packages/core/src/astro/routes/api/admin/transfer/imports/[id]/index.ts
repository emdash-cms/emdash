/**
 * GET /_emdash/api/admin/transfer/imports/:id — import status and upload counts.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleImportGet } from "#api/handlers/transfer.js";
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

	return unwrapResult(await handleImportGet(emdash.db, params.id ?? ""));
};
