/**
 * POST /_emdash/api/admin/transfer/exports/:id/advance
 *
 * Runs one bounded export step. Call again after `nextRequestInMs` until it
 * is null.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleExportAdvance } from "#api/handlers/transfer.js";
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

	if (!emdash.storage) {
		return apiError("STORAGE_NOT_CONFIGURED", "No storage backend is configured", 503);
	}

	return unwrapResult(
		await handleExportAdvance(emdash.db, emdash.storage, { operationId: params.id ?? "" }),
	);
};
