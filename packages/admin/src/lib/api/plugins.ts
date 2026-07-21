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
	/** True when the plugin declares `admin.settingsSchema` (auto-generated settings form) */
	hasSettings: boolean;
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
	/** Absent when talking to an older core that predates plugin MCP tools. */
	mcpToolsEnabled?: boolean;
	mcpTools?: Array<{
		name: string;
		description: string;
		route: string;
		permission: string;
		destructive: boolean;
	}>;
}

/**
 * Fetch all plugins
 */
export async function fetchPlugins(): Promise<PluginInfo[]> {
	const response = await apiFetch(`${API_BASE}/admin/plugins`);
	const result = await parseApiResponse<{ items: PluginInfo[] }>(
		response,
		i18n._(msg`Failed to fetch plugins`),
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
			throw new Error(i18n._(msg`Plugin "${pluginId}" not found`));
		}
		await throwResponseError(response, i18n._(msg`Failed to fetch plugin`));
	}
	const result = await parseApiResponse<{ item: PluginInfo }>(
		response,
		i18n._(msg`Failed to fetch plugin`),
	);
	return result.item;
}

// ── Plugin settings (auto-generated from settingsSchema) ─────────

interface BaseSettingField {
	label: string;
	description?: string;
}

export type SettingField =
	| (BaseSettingField & { type: "string"; default?: string; multiline?: boolean })
	| (BaseSettingField & { type: "number"; default?: number; min?: number; max?: number })
	| (BaseSettingField & { type: "boolean"; default?: boolean })
	| (BaseSettingField & {
			type: "select";
			options: Array<{ value: string; label: string }>;
			default?: string;
	  })
	| (BaseSettingField & { type: "secret" })
	| (BaseSettingField & { type: "url"; default?: string; placeholder?: string })
	| (BaseSettingField & { type: "email"; default?: string; placeholder?: string });

export interface PluginSettingsResponse {
	schema: Record<string, SettingField>;
	/** Current values; secret fields are never included (see secretsSet) */
	values: Record<string, unknown>;
	/** For secret fields: whether a value is currently stored */
	secretsSet: Record<string, boolean>;
}

/**
 * Fetch a plugin's settings schema and current values
 */
export async function fetchPluginSettings(pluginId: string): Promise<PluginSettingsResponse> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}/settings`);
	return parseApiResponse<PluginSettingsResponse>(
		response,
		i18n._(msg`Failed to fetch plugin settings`),
	);
}

/**
 * Update a plugin's settings. Only keys present in `values` are written;
 * `null` clears a stored value (reverting to the schema default).
 */
export async function updatePluginSettings(
	pluginId: string,
	values: Record<string, unknown>,
): Promise<PluginSettingsResponse> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}/settings`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ values }),
	});
	return parseApiResponse<PluginSettingsResponse>(
		response,
		i18n._(msg`Failed to update plugin settings`),
	);
}

/**
 * Enable a plugin
 */
export async function enablePlugin(pluginId: string): Promise<PluginInfo> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}/enable`, {
		method: "POST",
	});
	const result = await parseApiResponse<{ item: PluginInfo }>(
		response,
		i18n._(msg`Failed to enable plugin`),
	);
	return result.item;
}

/**
 * Disable a plugin
 */
export async function disablePlugin(pluginId: string): Promise<PluginInfo> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}/disable`, {
		method: "POST",
	});
	const result = await parseApiResponse<{ item: PluginInfo }>(
		response,
		i18n._(msg`Failed to disable plugin`),
	);
	return result.item;
}

export async function setPluginMcpEnabled(pluginId: string, enabled: boolean): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${pluginId}/mcp`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ enabled }),
	});
	if (!response.ok) {
		await throwResponseError(response, i18n._(msg`Failed to update plugin MCP access`));
	}
}
