/**
 * Settings handlers
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { getSiteSettingsWithDb, setSiteSettings } from "../../settings/index.js";
import type { SiteSettings, SiteSettingsUpdate } from "../../settings/types.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";

/**
 * Get all site settings
 */
export async function handleSettingsGet(
	db: Kysely<Database>,
	storage: Storage | null,
): Promise<ApiResult<Partial<SiteSettings>>> {
	try {
		const settings = await getSiteSettingsWithDb(db, storage);
		return { success: true, data: settings };
	} catch {
		return {
			success: false,
			error: { code: "SETTINGS_READ_ERROR", message: "Failed to get settings" },
		};
	}
}

/**
 * Update site settings
 */
export async function handleSettingsUpdate(
	db: Kysely<Database>,
	storage: Storage | null,
	input: SiteSettingsUpdate,
): Promise<ApiResult<Partial<SiteSettings>>> {
	try {
		await setSiteSettings(input, db);
		const updatedSettings = await getSiteSettingsWithDb(db, storage);
		return { success: true, data: updatedSettings };
	} catch {
		return {
			success: false,
			error: { code: "SETTINGS_UPDATE_ERROR", message: "Failed to update settings" },
		};
	}
}
