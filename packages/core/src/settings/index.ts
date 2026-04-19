/**
 * Site Settings API
 *
 * Functions for getting and setting global site configuration.
 * Settings are stored in the options table with 'site:' prefix.
 */

import type { Kysely } from "kysely";

import { MediaRepository } from "../database/repositories/media.js";
import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { requestCached } from "../request-cache.js";
import type { Storage } from "../storage/types.js";
import type { SiteSettings, SiteSettingKey, MediaReference } from "./types.js";

/** Prefix for site settings in the options table */
const SETTINGS_PREFIX = "site:";

/**
 * Type guard for MediaReference values
 */
function isMediaReference(value: unknown): value is MediaReference {
	return typeof value === "object" && value !== null && "mediaId" in value;
}

/**
 * Resolve a media reference to include the full URL
 */
async function resolveMediaReference(
	mediaRef: MediaReference | undefined,
	db: Kysely<Database>,
	_storage: Storage | null,
): Promise<(MediaReference & { url?: string }) | undefined> {
	if (!mediaRef?.mediaId) {
		return mediaRef;
	}

	try {
		const mediaRepo = new MediaRepository(db);
		const media = await mediaRepo.findById(mediaRef.mediaId);

		if (media) {
			// Construct URL using the same pattern as API handlers
			return {
				...mediaRef,
				url: `/_emdash/api/media/file/${media.storageKey}`,
			};
		}
	} catch {
		// If media not found or error, return the reference as-is
	}

	return mediaRef;
}

/**
 * Get a single site setting by key
 *
 * Returns `undefined` if the setting has not been configured.
 * For media settings (logo, favicon), the URL is resolved automatically.
 *
 * @param key - The setting key (e.g., "title", "logo", "social")
 * @returns The setting value, or undefined if not set
 *
 * @example
 * ```ts
 * import { getSiteSetting } from "emdash";
 *
 * const title = await getSiteSetting("title");
 * const logo = await getSiteSetting("logo");
 * console.log(logo?.url); // Resolved URL
 * ```
 */
export function getSiteSetting<K extends SiteSettingKey>(
	key: K,
): Promise<SiteSettings[K] | undefined> {
	// Cache per-key within a request. Without this, templates that pull
	// several settings (and layout components that ask for logo/favicon/
	// title separately) each fire an options-table query — which is a
	// real latency hit on regions far from the D1 primary (APS, APE).
	return requestCached(`siteSetting:${key}`, async () => {
		const db = await getDb();
		return getSiteSettingWithDb(key, db);
	});
}

/**
 * Get a single site setting by key (with explicit db)
 *
 * @internal Use `getSiteSetting()` in templates. This variant is for admin routes
 * that already have a database handle.
 */
export async function getSiteSettingWithDb<K extends SiteSettingKey>(
	key: K,
	db: Kysely<Database>,
	storage: Storage | null = null,
): Promise<SiteSettings[K] | undefined> {
	const options = new OptionsRepository(db);
	const value = await options.get<SiteSettings[K]>(`${SETTINGS_PREFIX}${key}`);

	if (!value) {
		return undefined;
	}

	// Resolve media references if needed.
	// TS cannot narrow generic K from key equality checks — this is a known limitation.
	// We use the non-generic getSiteSettingsWithDb for media resolution instead.
	if ((key === "logo" || key === "favicon") && isMediaReference(value)) {
		const resolved = await resolveMediaReference(value, db, storage);
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- TS can't narrow generic K from key equality; resolved type is correct
		return resolved as SiteSettings[K] | undefined;
	}

	return value;
}

/**
 * Get all site settings
 *
 * Returns all configured settings. Unset values are undefined.
 * Media references (logo/favicon) are resolved to include URLs.
 *
 * @example
 * ```ts
 * import { getSiteSettings } from "emdash";
 *
 * const settings = await getSiteSettings();
 * console.log(settings.title); // "My Site"
 * console.log(settings.logo?.url); // "/_emdash/api/media/file/abc123"
 * ```
 */
export function getSiteSettings(): Promise<Partial<SiteSettings>> {
	return requestCached("siteSettings", async () => {
		const db = await getDb();
		return getSiteSettingsWithDb(db);
	});
}

/**
 * Get all site settings (with explicit db)
 *
 * @internal Use `getSiteSettings()` in templates. This variant is for admin routes
 * that already have a database handle.
 */
export async function getSiteSettingsWithDb(
	db: Kysely<Database>,
	storage: Storage | null = null,
): Promise<Partial<SiteSettings>> {
	const options = new OptionsRepository(db);
	const allOptions = await options.getByPrefix(SETTINGS_PREFIX);

	const settings: Record<string, unknown> = {};

	// Convert Map to settings object, removing the prefix
	for (const [key, value] of allOptions) {
		const settingKey = key.replace(SETTINGS_PREFIX, "");
		settings[settingKey] = value;
	}

	const typedSettings = settings as Partial<SiteSettings>;

	// Resolve media references
	if (typedSettings.logo) {
		typedSettings.logo = await resolveMediaReference(typedSettings.logo, db, storage);
	}
	if (typedSettings.favicon) {
		typedSettings.favicon = await resolveMediaReference(typedSettings.favicon, db, storage);
	}

	return typedSettings;
}

/**
 * Set site settings (internal function used by admin API)
 *
 * Merges provided settings with existing ones. Only provided fields are updated.
 * Media references should include just the mediaId; URLs are resolved on read.
 *
 * @param settings - Partial settings object with values to update
 * @param db - Kysely database instance
 * @returns Promise that resolves when settings are saved
 *
 * @internal
 *
 * @example
 * ```ts
 * // Update multiple settings at once
 * await setSiteSettings({
 *   title: "My Site",
 *   tagline: "Welcome",
 *   logo: { mediaId: "med_123", alt: "Logo" }
 * }, db);
 * ```
 */
export async function setSiteSettings(
	settings: Partial<SiteSettings>,
	db: Kysely<Database>,
): Promise<void> {
	const options = new OptionsRepository(db);

	// Convert settings to options format
	const updates: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(settings)) {
		if (value !== undefined) {
			updates[`${SETTINGS_PREFIX}${key}`] = value;
		}
	}

	await options.setMany(updates);
}

/**
 * Get a single plugin setting by key.
 *
 * Plugin settings are stored in the options table under
 * `plugin:<pluginId>:settings:<key>`.
 */
export async function getPluginSetting<T = unknown>(
	pluginId: string,
	key: string,
): Promise<T | undefined> {
	const db = await getDb();
	return getPluginSettingWithDb<T>(pluginId, key, db);
}

/**
 * Get a single plugin setting by key (with explicit db).
 *
 * @internal Use `getPluginSetting()` in templates and plugin rendering code.
 */
export async function getPluginSettingWithDb<T = unknown>(
	pluginId: string,
	key: string,
	db: Kysely<Database>,
): Promise<T | undefined> {
	const options = new OptionsRepository(db);
	const value = await options.get<T>(`plugin:${pluginId}:settings:${key}`);
	return value ?? undefined;
}

/**
 * Get all persisted plugin settings for a plugin.
 *
 * Defaults declared in `admin.settingsSchema` are not materialized
 * automatically; callers should apply their own fallback defaults.
 */
export async function getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
	const db = await getDb();
	return getPluginSettingsWithDb(pluginId, db);
}

/**
 * Get all persisted plugin settings for a plugin (with explicit db).
 *
 * @internal Use `getPluginSettings()` in templates and plugin rendering code.
 */
export async function getPluginSettingsWithDb(
	pluginId: string,
	db: Kysely<Database>,
): Promise<Record<string, unknown>> {
	const prefix = `plugin:${pluginId}:settings:`;
	const options = new OptionsRepository(db);
	const allOptions = await options.getByPrefix(prefix);

	const settings: Record<string, unknown> = {};
	for (const [key, value] of allOptions) {
		if (!key.startsWith(prefix)) {
			continue;
		}
		settings[key.slice(prefix.length)] = value;
	}

	return settings;
}
