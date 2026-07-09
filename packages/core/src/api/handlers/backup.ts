/**
 * Backup handlers — portable content backups, on demand and scheduled.
 *
 * A backup is the snapshot format (see `snapshot.ts`) wrapped in a small
 * envelope: all content (including drafts, scheduled, and trashed entries),
 * schema definitions, taxonomies, menus, widgets, revisions, media metadata,
 * and site settings.
 *
 * Deliberately NOT included:
 * - Users, sessions, credentials, API/OAuth tokens (auth data is neither
 *   portable nor safe in a user-downloadable file)
 * - Secrets (`emdash:preview_secret`, plugin config, passkey challenges)
 * - Media binaries (metadata only — the files live in the same bucket the
 *   scheduled archives are written to)
 *
 * For full point-in-time database recovery on Cloudflare, D1 Time Travel
 * covers the last 30 days out of the box; these backups complement it with
 * user-holdable, longer-lived archives.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../../database/repositories/options.js";
import type { Database } from "../../database/types.js";
import type { Storage } from "../../storage/types.js";
import { VERSION } from "../../version.js";
import { ErrorCode } from "../errors.js";
import type { ApiResult } from "../types.js";
import { generateSnapshot } from "./snapshot.js";

// ── Constants ───────────────────────────────────────────────────

/** Storage key prefix for scheduled/manual archives. */
export const BACKUP_STORAGE_PREFIX = "backups/";

/**
 * Filename prefix within the backups/ folder. Included in the list() prefix
 * so LocalStorage (which matches directory + filename prefix, not flat keys
 * like S3/R2) finds the archives too.
 */
const BACKUP_FILE_PREFIX = "emdash-backup-";

/** Options key holding the scheduled-backup settings. */
export const BACKUP_SETTINGS_KEY = "emdash:backups";

/** Options key holding the ISO timestamp of the last scheduled run. */
const BACKUP_LAST_RUN_KEY = "emdash:backups_last_run";

/** Minimum interval between scheduled backups (23h — daily with cron jitter). */
const SCHEDULED_BACKUP_INTERVAL_MS = 23 * 60 * 60 * 1000;

/** Retention bounds for stored archives. */
export const BACKUP_RETENTION_MIN = 1;
export const BACKUP_RETENTION_MAX = 30;
const BACKUP_RETENTION_DEFAULT = 7;

/**
 * Options-table key prefixes included in backups. Site settings plus the
 * site-identity keys (`emdash:site_title`, `emdash:site_tagline`,
 * `emdash:site_url`). Never widen this to a prefix that can match secrets
 * (`emdash:preview_secret`, `plugin:`, `emdash:passkey_pending:`).
 */
const BACKUP_OPTION_PREFIXES = ["site:", "emdash:site_", "emdash:locale"];

/**
 * Archive filename shape. Strict allowlist — the download/delete routes
 * interpolate this into a storage key, so it must never contain `/` or `..`.
 * The random suffix makes names unguessable (defense in depth on top of the
 * media route's backups/ deny) and avoids same-second collisions.
 */
const ARCHIVE_NAME_PATTERN =
	/^emdash-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.json$/;

export function isValidArchiveName(name: string): boolean {
	return ARCHIVE_NAME_PATTERN.test(name);
}

// ── Types ───────────────────────────────────────────────────────

export interface BackupSettings {
	/** Whether daily scheduled backups to storage are enabled. */
	enabled: boolean;
	/** How many archives to keep in storage (oldest pruned first). */
	retention: number;
}

export interface BackupArchive {
	/** Filename within the backups/ prefix (no path separators). */
	name: string;
	/** Size in bytes. */
	size: number;
	/** Last-modified timestamp (ISO). */
	lastModified: string;
}

const DEFAULT_SETTINGS: BackupSettings = {
	enabled: false,
	retention: BACKUP_RETENTION_DEFAULT,
};

function clampRetention(value: number): number {
	if (!Number.isFinite(value)) return BACKUP_RETENTION_DEFAULT;
	return Math.min(BACKUP_RETENTION_MAX, Math.max(BACKUP_RETENTION_MIN, Math.trunc(value)));
}

// ── Export ──────────────────────────────────────────────────────

/**
 * Generate a full content backup as a JSON string.
 *
 * ponytail: the whole backup is materialized in memory. Fine for the sites
 * EmDash targets today; truly huge databases should use `wrangler d1 export`
 * (documented on the backups docs page). Upgrade path: stream table-by-table.
 */
export async function generateBackupJson(db: Kysely<Database>): Promise<string> {
	const snapshot = await generateSnapshot(db, {
		includeDrafts: true,
		includeTrashed: true,
		optionPrefixes: BACKUP_OPTION_PREFIXES,
	});

	return JSON.stringify({
		format: "emdash-backup",
		formatVersion: 1,
		emdashVersion: VERSION,
		generatedAt: snapshot.generatedAt,
		schema: snapshot.schema,
		tables: snapshot.tables,
	});
}

/** Derive the archive filename for a given date (plus a random suffix). */
export function archiveNameForDate(date: Date): string {
	// 2026-07-09T08:45:12.345Z → emdash-backup-2026-07-09T08-45-12-1a2b3c4d.json
	const stamp = date.toISOString().slice(0, 19).replaceAll(":", "-");
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
	return `emdash-backup-${stamp}-${suffix}.json`;
}

// ── Settings ────────────────────────────────────────────────────

export async function getBackupSettings(db: Kysely<Database>): Promise<BackupSettings> {
	const options = new OptionsRepository(db);
	const stored = await options.get<Partial<BackupSettings>>(BACKUP_SETTINGS_KEY);
	if (!stored) return { ...DEFAULT_SETTINGS };
	return {
		enabled: stored.enabled === true,
		retention: clampRetention(stored.retention ?? BACKUP_RETENTION_DEFAULT),
	};
}

export async function updateBackupSettings(
	db: Kysely<Database>,
	input: { enabled: boolean; retention: number },
): Promise<ApiResult<BackupSettings>> {
	try {
		const settings: BackupSettings = {
			enabled: input.enabled,
			retention: clampRetention(input.retention),
		};
		const options = new OptionsRepository(db);
		await options.set(BACKUP_SETTINGS_KEY, settings);
		return { success: true, data: settings };
	} catch (error) {
		console.error("[backup] Failed to update settings:", error);
		return {
			success: false,
			error: { code: ErrorCode.BACKUP_SETTINGS_ERROR, message: "Failed to update backup settings" },
		};
	}
}

// ── Archives in storage ─────────────────────────────────────────

/**
 * List stored archives, newest first.
 *
 * ponytail: single unpaginated list. The retention cap (max 30) bounds the
 * archive count, so one page always suffices.
 */
export async function listBackupArchives(storage: Storage): Promise<ApiResult<BackupArchive[]>> {
	try {
		const result = await storage.list({
			prefix: `${BACKUP_STORAGE_PREFIX}${BACKUP_FILE_PREFIX}`,
			limit: 100,
		});
		const archives = result.files
			.map((file) => ({
				name: file.key.slice(BACKUP_STORAGE_PREFIX.length),
				size: file.size,
				lastModified: file.lastModified.toISOString(),
			}))
			.filter((archive) => isValidArchiveName(archive.name))
			.toSorted((a, b) => (a.name < b.name ? 1 : -1));
		return { success: true, data: archives };
	} catch (error) {
		console.error("[backup] Failed to list archives:", error);
		return {
			success: false,
			error: { code: ErrorCode.BACKUP_LIST_ERROR, message: "Failed to list backup archives" },
		};
	}
}

/**
 * Create a backup and store it as an archive, then prune old archives
 * beyond `retention`.
 */
export async function runBackupToStorage(
	db: Kysely<Database>,
	storage: Storage,
	retention: number,
): Promise<ApiResult<BackupArchive>> {
	try {
		const json = await generateBackupJson(db);
		const name = archiveNameForDate(new Date());
		const body = new TextEncoder().encode(json);

		await storage.upload({
			key: `${BACKUP_STORAGE_PREFIX}${name}`,
			body,
			contentType: "application/json",
		});

		await pruneArchives(storage, clampRetention(retention));

		return {
			success: true,
			data: { name, size: body.byteLength, lastModified: new Date().toISOString() },
		};
	} catch (error) {
		console.error("[backup] Failed to create archive:", error);
		return {
			success: false,
			error: { code: ErrorCode.BACKUP_CREATE_ERROR, message: "Failed to create backup archive" },
		};
	}
}

/** Delete archives beyond the newest `keep`. Failures are logged, not fatal. */
async function pruneArchives(storage: Storage, keep: number): Promise<void> {
	const listed = await listBackupArchives(storage);
	if (!listed.success) return;

	for (const archive of listed.data.slice(keep)) {
		try {
			await storage.delete(`${BACKUP_STORAGE_PREFIX}${archive.name}`);
		} catch (error) {
			console.error(`[backup] Failed to prune archive ${archive.name}:`, error);
		}
	}
}

export async function deleteBackupArchive(
	storage: Storage,
	name: string,
): Promise<ApiResult<{ deleted: true }>> {
	if (!isValidArchiveName(name)) {
		return {
			success: false,
			error: { code: ErrorCode.VALIDATION_ERROR, message: "Invalid archive name" },
		};
	}
	try {
		await storage.delete(`${BACKUP_STORAGE_PREFIX}${name}`);
		return { success: true, data: { deleted: true } };
	} catch (error) {
		console.error(`[backup] Failed to delete archive ${name}:`, error);
		return {
			success: false,
			error: { code: ErrorCode.BACKUP_DELETE_ERROR, message: "Failed to delete backup archive" },
		};
	}
}

// ── Scheduled runs ──────────────────────────────────────────────

/**
 * Run a scheduled backup if enabled and due. Called from the maintenance
 * tick alongside scheduled publishing and system cleanup — never from a
 * request. Never throws.
 *
 * ponytail: last-run bookkeeping is a plain read-then-write, so two isolates
 * ticking simultaneously could both back up. Worst case is a duplicate
 * archive that retention prunes; not worth a lock.
 */
export async function maybeRunScheduledBackup(
	db: Kysely<Database>,
	storage: Storage | undefined,
): Promise<void> {
	try {
		if (!storage) return;

		const settings = await getBackupSettings(db);
		if (!settings.enabled) return;

		const options = new OptionsRepository(db);
		const lastRun = await options.get<string>(BACKUP_LAST_RUN_KEY);
		if (lastRun) {
			const elapsed = Date.now() - Date.parse(lastRun);
			if (Number.isFinite(elapsed) && elapsed < SCHEDULED_BACKUP_INTERVAL_MS) return;
		}

		const result = await runBackupToStorage(db, storage, settings.retention);
		if (result.success) {
			await options.set(BACKUP_LAST_RUN_KEY, new Date().toISOString());
			console.log(`[backup] Scheduled backup stored: ${result.data.name}`);
		}
	} catch (error) {
		console.error("[backup] Scheduled backup failed:", error);
	}
}
