/**
 * Site Settings API endpoint
 *
 * GET  /_emdash/api/settings - Get all site settings
 * POST /_emdash/api/settings - Update site settings
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleSettingsGet, handleSettingsUpdate } from "#api/handlers/settings.js";
import { isParseError, parseBody } from "#api/parse.js";
import { settingsUpdateBody } from "#api/schemas.js";

import { EDGE_TAG_SETTINGS, invalidateEdgeTag } from "../../edge-cache-tags.js";

export const prerender = false;

/**
 * GET /_emdash/api/settings
 *
 * Returns all site settings as a JSON object.
 * Unset values are undefined. Media references include resolved URLs.
 */
export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:read");
	if (denied) return denied;

	try {
		const result = await handleSettingsGet(emdash.db, emdash.storage);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get settings", "SETTINGS_READ_ERROR");
	}
};

/**
 * POST /_emdash/api/settings
 *
 * Updates site settings. Accepts a partial settings object.
 * Merges with existing settings and returns the updated settings.
 */
export const POST: APIRoute = async ({ request, locals, cache }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, settingsUpdateBody);
		if (isParseError(body)) return body;

		const result = await handleSettingsUpdate(emdash.db, emdash.storage, body);
		// Purge the edge cache for every page that renders site settings
		// (typically all of them). No-op without a cache provider (#2042).
		if (result.success) await invalidateEdgeTag(cache, EDGE_TAG_SETTINGS);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update settings", "SETTINGS_UPDATE_ERROR");
	}
};
