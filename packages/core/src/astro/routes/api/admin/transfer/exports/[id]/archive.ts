/**
 * GET /_emdash/api/admin/transfer/exports/:id/archive
 *
 * The complete export as one streamed `.emdash` (tar) archive, manifest
 * first.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleExportArchive } from "#api/handlers/transfer.js";
import { exportArchiveResponse } from "#api/transfer-download.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
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

	const id = params.id ?? "";
	const result = await handleExportArchive(emdash.db, emdash.storage, id);
	return result.success ? exportArchiveResponse(id, result.data.body) : unwrapResult(result);
};
