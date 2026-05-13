/**
 * Plugin management APIs
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface PluginInfo {
	id: string;
	name: string;
	version: string;
	package?: string;
	enabled: boolean;
	status: "installed" | "active" | "inactive";
	capabilities: string[];
	hasAdminPages: boolean;
	hasDashboardWidgets: boolean;
	hasHooks: boolean;
	installedAt?: string;
	activatedAt?: string;
	deactivatedAt?: string;
	/** Plugin source: 'config' (declared in astro.config), 'marketplace', or 'registry' */
	source?: "config" | "marketplace" | "registry";
	/** Installed marketplace version (set when source = 'marketplace') */
	marketplaceVersion?: string;
	/** Publisher DID, for registry-source plugins. */
	registryPublisherDid?: string;
	/** Publisher slug, for registry-source plugins. */
	registrySlug?: string;
	/** Description of what the plugin does */
	description?: string;
	/** URL to the plugin icon (marketplace plugins use the icon proxy) */
	iconUrl?: string;
}

/**
 * Fetch all plugins
 */
export async function fetchPlugins(): Promise<PluginInfo[]> {
	const response = await apiFetch(`${API_BASE}/admin/plugins`);
	const result = await parseApiResponse<{ items: PluginInfo[] }>(
		response,
		"Failed to fetch plugins",
	);
	return result.items;
}

/**
 * Fetch a single plugin
 */
export async function fetchPlugin(pluginId: string): Promise<PluginInfo> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}`);
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`Plugin "${pluginId}" not found`);
		}
		await throwResponseError(response, i18n._(msg`Failed to fetch plugin`));
	}
	const result = await parseApiResponse<{ item: PluginInfo }>(
		response,
		i18n._(msg`Failed to fetch plugin`),
	);
	return result.item;
}

/**
 * Enable a plugin
 */
export async function enablePlugin(pluginId: string): Promise<PluginInfo> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}/enable`, {
		method: "POST",
	});
	const result = await parseApiResponse<{ item: PluginInfo }>(response, "Failed to enable plugin");
	return result.item;
}

/**
 * Disable a plugin
 */
export async function disablePlugin(pluginId: string): Promise<PluginInfo> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}/disable`, {
		method: "POST",
	});
	const result = await parseApiResponse<{ item: PluginInfo }>(response, "Failed to disable plugin");
	return result.item;
}
