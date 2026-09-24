/**
 * POST /_emdash/api/admin/transfer/imports/:id/cancel
 *
 * Cancels an import. A step in progress stops after its current batch.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleImportCancel } from "#api/handlers/transfer.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:execute");
	if (scopeDenied) return scopeDenied;

	return unwrapResult(await handleImportCancel(emdash.db, params.id ?? "", user!.id));
};
