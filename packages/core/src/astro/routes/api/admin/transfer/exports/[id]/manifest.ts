/**
 * GET /_emdash/api/admin/transfer/exports/:id/manifest
 *
 * The complete export's `manifest.json`, byte for byte.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleExportFile } from "#api/handlers/transfer.js";
import { exportFileResponse } from "#api/transfer-download.js";
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

	const result = await handleExportFile(
		emdash.db,
		emdash.storage,
		params.id ?? "",
		"manifest.json",
	);
	return result.success ? exportFileResponse(result.data) : unwrapResult(result);
};
