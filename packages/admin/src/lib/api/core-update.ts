/**
 * Core update status API (Discussion #1889)
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface CoreUpdateStatus {
	/** The running EmDash version ("dev" in uncompiled dev runs). */
	current: string;
	/** Latest published version, or null when no check has completed yet. */
	latest: string | null;
	updateAvailable: boolean;
	/** ISO timestamp of the last successful registry check, if any. */
	checkedAt: string | null;
}

/**
 * Fetch the cached core update status. The server defers the actual
 * registry check, so this is always a fast local read.
 */
export async function fetchCoreUpdateStatus(): Promise<CoreUpdateStatus> {
	const response = await apiFetch(`${API_BASE}/admin/core-update`);
	return parseApiResponse<CoreUpdateStatus>(response, i18n._(msg`Failed to fetch update status`));
}
