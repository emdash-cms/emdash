/**
 * Admin navigation (sidebar IA) handlers.
 *
 * Read/write the site-wide sidebar organization (custom groups, ordering,
 * hidden items) stored in the `options` table. The manifest embeds the same
 * normalized config for rendering; these handlers back the settings
 * organizer UI.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../../database/repositories/options.js";
import type { Database } from "../../database/types.js";
import { ErrorCode } from "../errors.js";
import {
	ADMIN_NAVIGATION_OPTION_KEY,
	normalizeAdminNavigationConfig,
	type AdminNavigationConfigV1,
} from "../schemas/admin-navigation.js";
import type { ApiResult } from "../types.js";

/**
 * Read the stored navigation config, normalized.
 *
 * Unset, schema-invalid, and JSON-corrupt values all read as `null` so the
 * organizer starts from defaults and can overwrite bad state; only real
 * database failures surface as errors.
 */
export async function getAdminNavigation(
	db: Kysely<Database>,
): Promise<ApiResult<{ config: AdminNavigationConfigV1 | null }>> {
	try {
		const options = new OptionsRepository(db);
		let stored: unknown = null;
		try {
			stored = await options.get(ADMIN_NAVIGATION_OPTION_KEY);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		const config = stored === null ? undefined : normalizeAdminNavigationConfig(stored);
		return { success: true, data: { config: config ?? null } };
	} catch (error) {
		console.error("[admin-navigation] Failed to read navigation config:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.NAV_CONFIG_READ_ERROR,
				message: "Failed to read navigation config",
			},
		};
	}
}

/**
 * Replace the stored navigation config with the normalized form of `input`.
 */
export async function setAdminNavigation(
	db: Kysely<Database>,
	input: AdminNavigationConfigV1,
): Promise<ApiResult<{ config: AdminNavigationConfigV1 }>> {
	const config = normalizeAdminNavigationConfig(input);
	if (!config) {
		return {
			success: false,
			error: { code: ErrorCode.VALIDATION_ERROR, message: "Invalid navigation config" },
		};
	}
	try {
		const options = new OptionsRepository(db);
		await options.set(ADMIN_NAVIGATION_OPTION_KEY, config);
		return { success: true, data: { config } };
	} catch (error) {
		console.error("[admin-navigation] Failed to save navigation config:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.NAV_CONFIG_SAVE_ERROR,
				message: "Failed to save navigation config",
			},
		};
	}
}
