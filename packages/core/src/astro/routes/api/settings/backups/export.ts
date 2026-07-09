/**
 * One-click backup download
 *
 * GET /_emdash/api/settings/backups/export — generate a fresh backup and
 * stream it as a JSON download. Read-only (nothing is stored), so GET is
 * appropriate despite the cost of generating the payload.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError } from "#api/error.js";
import { ErrorCode } from "#api/errors.js";
import { archiveNameForDate, generateBackupJson } from "#api/handlers/backup.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "backups:manage");
	if (denied) return denied;

	try {
		const json = await generateBackupJson(emdash.db);
		return new Response(json, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Content-Disposition": `attachment; filename="${archiveNameForDate(new Date())}"`,
				// Session-specific full-content export — never cacheable anywhere.
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		return handleError(error, "Failed to generate backup", ErrorCode.BACKUP_EXPORT_ERROR);
	}
};
