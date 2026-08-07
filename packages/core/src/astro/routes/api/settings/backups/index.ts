/**
 * Backup settings + archive listing
 *
 * GET /_emdash/api/settings/backups — scheduled-backup settings, stored
 *   archives, and whether a storage backend is available.
 * PUT /_emdash/api/settings/backups — update scheduled-backup settings.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { ErrorCode } from "#api/errors.js";
import {
	BACKUP_RETENTION_MAX,
	BACKUP_RETENTION_MIN,
	getBackupSettings,
	listBackupArchives,
	updateBackupSettings,
	type BackupArchive,
} from "#api/handlers/backup.js";
import { isParseError, parseBody } from "#api/parse.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "backups:manage");
	if (denied) return denied;

	try {
		const settings = await getBackupSettings(emdash.db);

		let archives: BackupArchive[] = [];
		const storageAvailable = !!emdash.storage;
		if (emdash.storage) {
			const listed = await listBackupArchives(emdash.storage);
			if (listed.success) archives = listed.data;
		}

		return apiSuccess({ settings, archives, storageAvailable });
	} catch (error) {
		return handleError(
			error,
			"Failed to load backup settings",
			ErrorCode.BACKUP_SETTINGS_READ_ERROR,
		);
	}
};

const settingsBody = z.object({
	enabled: z.boolean(),
	retention: z.number().int().min(BACKUP_RETENTION_MIN).max(BACKUP_RETENTION_MAX),
});

export const PUT: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "backups:manage");
	if (denied) return denied;

	const body = await parseBody(request, settingsBody);
	if (isParseError(body)) return body;

	return unwrapResult(await updateBackupSettings(emdash.db, body));
};
