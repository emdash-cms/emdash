/**
 * Serve uploaded media files
 *
 * GET /_emdash/api/media/file/:key - Serve file from storage
 */

import type { APIRoute } from "astro";

import { apiError } from "#api/error.js";
import { serveStoredMedia } from "#media/serve-file.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { key } = params;
	const { emdash } = locals;

	if (!key) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	// Backup archives share the storage bucket but hold the site's full
	// content export — they must never be reachable through the public,
	// unauthenticated media route. Admins download them via the
	// authenticated backups API.
	if (key.startsWith("backups/") || key.startsWith("private/")) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	if (!emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage not configured", 500);
	}

	return serveStoredMedia(emdash.storage, key, "public, max-age=31536000, immutable");
};
