/**
 * Admin navigation (sidebar organizer) API client
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { AdminNavigationConfig } from "../admin-nav";
import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

/** Read the stored navigation config; null when the site uses defaults. */
export async function fetchAdminNavigation(): Promise<AdminNavigationConfig | null> {
	const response = await apiFetch(`${API_BASE}/admin/navigation`);
	const data = await parseApiResponse<{ config: AdminNavigationConfig | null }>(
		response,
		i18n._(msg`Failed to load navigation settings`),
	);
	return data.config;
}

/** Replace the stored navigation config; returns the normalized form. */
export async function updateAdminNavigation(
	config: AdminNavigationConfig,
): Promise<AdminNavigationConfig> {
	const response = await apiFetch(`${API_BASE}/admin/navigation`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(config),
	});
	const data = await parseApiResponse<{ config: AdminNavigationConfig }>(
		response,
		i18n._(msg`Failed to save navigation settings`),
	);
	return data.config;
}
