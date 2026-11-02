/**
 * Settings handlers
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import {
	getSiteSettingWithDb,
	getSiteSettingsWithDb,
	setSiteSettings,
} from "../../settings/index.js";
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
		const { timezone } = input;
		if (
			typeof timezone === "string" &&
			!isValidTimeZone(timezone) &&
			// A previously stored value is sent back unchanged by the admin's settings
			// form; rejecting it would block saving every other setting.
			timezone !== (await getSiteSettingWithDb("timezone", db))
		) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `timezone: "${timezone}" is not an IANA timezone (for example "Europe/Lisbon" or "UTC")`,
				},
			};
		}
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

function isValidTimeZone(timezone: string): boolean {
	try {
		return Boolean(
			new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone,
		);
	} catch {
		return false;
	}
}
