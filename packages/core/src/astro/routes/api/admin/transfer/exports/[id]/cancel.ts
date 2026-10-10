/**
 * POST /_emdash/api/admin/transfer/exports/:id/cancel
 *
 * Cancels an export. A step in progress stops after its current batch.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleExportCancel } from "#api/handlers/transfer.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "transfer:export");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:export");
	if (scopeDenied) return scopeDenied;

	return unwrapResult(await handleExportCancel(emdash.db, params.id ?? "", user!.id));
};
