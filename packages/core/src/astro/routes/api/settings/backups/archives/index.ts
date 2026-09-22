/**
 * Backup archives — create
 *
 * POST /_emdash/api/settings/backups/archives — generate a backup and store
 * it in the storage backend under `backups/`, pruning archives beyond the
 * configured retention.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { getBackupSettings, runBackupToStorage } from "#api/handlers/backup.js";

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "backups:manage");
	if (denied) return denied;

	if (!emdash.storage) {
		return apiError("STORAGE_NOT_CONFIGURED", "No storage backend is configured", 503);
	}

	const settings = await getBackupSettings(emdash.db);
	return unwrapResult(await runBackupToStorage(emdash.db, emdash.storage, settings.retention), 201);
};
