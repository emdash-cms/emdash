/**
 * Backup settings API client functions
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

// =============================================================================
// Types
// =============================================================================

export interface BackupSettings {
	enabled: boolean;
	retention: number;
}

export interface BackupArchive {
	name: string;
	size: number;
	lastModified: string;
}

export interface BackupOverview {
	settings: BackupSettings;
	archives: BackupArchive[];
	storageAvailable: boolean;
}

// =============================================================================
// API functions
// =============================================================================

export async function fetchBackupOverview(): Promise<BackupOverview> {
	const res = await apiFetch(`${API_BASE}/settings/backups`);
	return parseApiResponse<BackupOverview>(res, i18n._(msg`Failed to fetch backup settings`));
}

export async function updateBackupSettings(settings: BackupSettings): Promise<BackupSettings> {
	const res = await apiFetch(`${API_BASE}/settings/backups`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return parseApiResponse<BackupSettings>(res, i18n._(msg`Failed to update backup settings`));
}

export async function createBackupArchive(): Promise<BackupArchive> {
	const res = await apiFetch(`${API_BASE}/settings/backups/archives`, { method: "POST" });
	return parseApiResponse<BackupArchive>(res, i18n._(msg`Failed to create backup`));
}

export async function deleteBackupArchive(name: string): Promise<void> {
	const res = await apiFetch(`${API_BASE}/settings/backups/archives/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
	await parseApiResponse<{ deleted: boolean }>(res, i18n._(msg`Failed to delete backup`));
}

/** URL for the one-click full backup download (plain GET, session cookie auth). */
export const BACKUP_EXPORT_URL = `${API_BASE}/settings/backups/export`;

/** URL for downloading a stored archive. */
export function backupArchiveUrl(name: string): string {
	return `${API_BASE}/settings/backups/archives/${encodeURIComponent(name)}`;
}
