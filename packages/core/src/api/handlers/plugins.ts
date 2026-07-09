/**
 * Plugin management handlers
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import type { SandboxedPluginEntry } from "../../emdash-runtime.js";
import { PluginStateRepository, type PluginState, type PluginStatus } from "../../plugins/state.js";
import type { ResolvedPlugin } from "../../plugins/types.js";
import type { ApiResult } from "../types.js";

export interface PluginInfo {
	id: string;
	name: string;
	version: string;
	package?: string;
	enabled: boolean;
	status: PluginStatus;
	source?: "config" | "marketplace" | "registry";
	/** True for statically-sandboxed plugins (registered via `sandboxed: []`) */
	sandboxed?: boolean;
	marketplaceVersion?: string;
	/** Publisher DID, for registry-source plugins */
	registryPublisherDid?: string;
	/** Publisher slug, for registry-source plugins */
	registrySlug?: string;
	capabilities: string[];
	hasAdminPages: boolean;
	hasDashboardWidgets: boolean;
	hasHooks: boolean;
	/** True when the plugin declares `admin.settingsSchema` (auto-generated settings form) */
	hasSettings: boolean;
	installedAt?: string;
	activatedAt?: string;
	deactivatedAt?: string;
	/** Description of what the plugin does */
	description?: string;
	/** URL to the plugin icon on the marketplace */
	iconUrl?: string;
}

export interface PluginListResponse {
	items: PluginInfo[];
}

export interface PluginResponse {
	item: PluginInfo;
}

function marketplaceIconUrl(marketplaceUrl: string, pluginId: string): string {
	return `${marketplaceUrl}/api/v1/plugins/${encodeURIComponent(pluginId)}/icon`;
}

/**
 * Get plugin info from configured plugin and database state
 */
function buildPluginInfo(
	plugin: ResolvedPlugin,
	state: PluginState | null,
	marketplaceUrl?: string,
): PluginInfo {
	// If no state exists, plugin is considered active (default on first run)
	const status = state?.status ?? "active";
	const enabled = status === "active";
	const isMarketplace = (state?.source ?? "config") === "marketplace";

	return {
		id: plugin.id,
		name: state?.displayName || plugin.id,
		version: plugin.version,
		package: undefined, // v2 doesn't have package field
		enabled,
		status,
		source: state?.source ?? "config",
		marketplaceVersion: state?.marketplaceVersion ?? undefined,
		registryPublisherDid: state?.registryPublisherDid ?? undefined,
		registrySlug: state?.registrySlug ?? undefined,
		capabilities: plugin.capabilities,
		hasAdminPages: (plugin.admin.pages?.length ?? 0) > 0,
		hasDashboardWidgets: (plugin.admin.widgets?.length ?? 0) > 0,
		hasHooks: Object.keys(plugin.hooks ?? {}).length > 0,
		hasSettings: Object.keys(plugin.admin.settingsSchema ?? {}).length > 0,
		installedAt: state?.installedAt?.toISOString(),
		activatedAt: state?.activatedAt?.toISOString() ?? undefined,
		deactivatedAt: state?.deactivatedAt?.toISOString() ?? undefined,
		description: state?.description ?? undefined,
		iconUrl:
			isMarketplace && marketplaceUrl ? marketplaceIconUrl(marketplaceUrl, plugin.id) : undefined,
	};
}

/**
 * Build plugin info for a statically-sandboxed plugin entry
 */
function buildSandboxedPluginInfo(
	entry: SandboxedPluginEntry,
	state: PluginState | null,
): PluginInfo {
	const status = state?.status ?? "active";
	const enabled = status === "active";

	return {
		id: entry.id,
		name: state?.displayName || entry.id,
		version: entry.version,
		package: undefined, // v2 doesn't have package field
		enabled,
		status,
		source: "config",
		sandboxed: true,
		capabilities: entry.capabilities,
		hasAdminPages: (entry.adminPages?.length ?? 0) > 0,
		hasDashboardWidgets: (entry.adminWidgets?.length ?? 0) > 0,
		hasHooks: false,
		hasSettings: Object.keys(entry.settingsSchema ?? {}).length > 0,
		installedAt: state?.installedAt?.toISOString(),
		activatedAt: state?.activatedAt?.toISOString() ?? undefined,
		deactivatedAt: state?.deactivatedAt?.toISOString() ?? undefined,
		description: state?.description ?? undefined,
	};
}

/**
 * List all configured plugins with their state
 */
export async function handlePluginList(
	db: Kysely<Database>,
	configuredPlugins: ResolvedPlugin[],
	sandboxedPluginEntries: SandboxedPluginEntry[],
	marketplaceUrl?: string,
	/**
	 * Settings-schema lookup for runtime-installed (marketplace/registry)
	 * plugins, which aren't in either build-time list. Typically
	 * `EmDashRuntime.getRuntimePluginSettingsSchema`.
	 */
	runtimeSettingsSchemaLookup?: (pluginId: string) => Record<string, unknown> | null,
): Promise<ApiResult<PluginListResponse>> {
	try {
		const stateRepo = new PluginStateRepository(db);
		const allStates = await stateRepo.getAll();
		const stateMap = new Map(allStates.map((s) => [s.pluginId, s]));

		const configuredIds = new Set(configuredPlugins.map((p) => p.id));

		const items = configuredPlugins.map((plugin) => {
			const state = stateMap.get(plugin.id) ?? null;
			return buildPluginInfo(plugin, state, marketplaceUrl);
		});

		// Include statically-sandboxed plugins (registered via `sandboxed: []`
		// in astro.config.mjs).
		for (const entry of sandboxedPluginEntries) {
			if (configuredIds.has(entry.id)) continue;
			configuredIds.add(entry.id);
			items.push(buildSandboxedPluginInfo(entry, stateMap.get(entry.id) ?? null));
		}

		// Include runtime-installed plugins (marketplace or registry) that
		// aren't in the configured plugins list.
		for (const state of allStates) {
			if (state.source !== "marketplace" && state.source !== "registry") continue;
			if (configuredIds.has(state.pluginId)) continue;

			items.push({
				id: state.pluginId,
				name: state.displayName || state.pluginId,
				version: state.marketplaceVersion ?? state.version,
				enabled: state.status === "active",
				status: state.status,
				source: state.source,
				marketplaceVersion: state.marketplaceVersion ?? undefined,
				registryPublisherDid: state.registryPublisherDid ?? undefined,
				registrySlug: state.registrySlug ?? undefined,
				capabilities: [],
				hasAdminPages: false,
				hasDashboardWidgets: false,
				hasHooks: false,
				hasSettings: Object.keys(runtimeSettingsSchemaLookup?.(state.pluginId) ?? {}).length > 0,
				installedAt: state.installedAt?.toISOString(),
				activatedAt: state.activatedAt?.toISOString() ?? undefined,
				deactivatedAt: state.deactivatedAt?.toISOString() ?? undefined,
				description: state.description ?? undefined,
				iconUrl:
					state.source === "marketplace" && marketplaceUrl
						? marketplaceIconUrl(marketplaceUrl, state.pluginId)
						: undefined,
			});
		}

		return {
			success: true,
			data: { items },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "PLUGIN_LIST_ERROR",
				message: "Failed to list plugins",
			},
		};
	}
}

/**
 * Get a single plugin's info
 */
export async function handlePluginGet(
	db: Kysely<Database>,
	configuredPlugins: ResolvedPlugin[],
	sandboxedPluginEntries: SandboxedPluginEntry[],
	pluginId: string,
	marketplaceUrl?: string,
): Promise<ApiResult<PluginResponse>> {
	try {
		const stateRepo = new PluginStateRepository(db);
		const plugin = configuredPlugins.find((p) => p.id === pluginId);

		if (plugin) {
			const state = await stateRepo.get(pluginId);
			return {
				success: true,
				data: { item: buildPluginInfo(plugin, state, marketplaceUrl) },
			};
		}

		const sandboxed = sandboxedPluginEntries.find((e) => e.id === pluginId);
		if (sandboxed) {
			const state = await stateRepo.get(pluginId);
			return {
				success: true,
				data: { item: buildSandboxedPluginInfo(sandboxed, state) },
			};
		}

		return {
			success: false,
			error: {
				code: "NOT_FOUND",
				message: `Plugin not found: ${pluginId}`,
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "PLUGIN_GET_ERROR",
				message: "Failed to get plugin",
			},
		};
	}
}

/**
 * Build a minimal `PluginInfo` for a plugin that exists only as a
 * `_plugin_state` row (marketplace or registry install), with no
 * matching `configuredPlugins` entry. Runtime-installed plugins don't
 * have ResolvedPlugin metadata until they're loaded into the sandbox,
 * so the enable/disable response surfaces the state-row view as a
 * stable shape the admin UI already understands.
 */
function buildStateOnlyPluginInfo(
	state: NonNullable<Awaited<ReturnType<PluginStateRepository["get"]>>>,
): PluginInfo {
	return {
		id: state.pluginId,
		name: state.displayName || state.pluginId,
		version: state.marketplaceVersion ?? state.version,
		enabled: state.status === "active",
		status: state.status,
		source: state.source,
		marketplaceVersion: state.marketplaceVersion ?? undefined,
		registryPublisherDid: state.registryPublisherDid ?? undefined,
		registrySlug: state.registrySlug ?? undefined,
		capabilities: [],
		hasAdminPages: false,
		hasDashboardWidgets: false,
		hasHooks: false,
		hasSettings: false,
		installedAt: state.installedAt?.toISOString(),
		activatedAt: state.activatedAt?.toISOString() ?? undefined,
		deactivatedAt: state.deactivatedAt?.toISOString() ?? undefined,
		description: state.description ?? undefined,
	};
}

/**
 * Enable a plugin
 */
export async function handlePluginEnable(
	db: Kysely<Database>,
	configuredPlugins: ResolvedPlugin[],
	sandboxedPluginEntries: SandboxedPluginEntry[],
	pluginId: string,
): Promise<ApiResult<PluginResponse>> {
	try {
		const stateRepo = new PluginStateRepository(db);
		const plugin = configuredPlugins.find((p) => p.id === pluginId);

		// Configured plugin: use its version as the source of truth.
		if (plugin) {
			const state = await stateRepo.enable(pluginId, plugin.version);
			return { success: true, data: { item: buildPluginInfo(plugin, state) } };
		}

		// Statically-sandboxed plugin: addressable via its build-time entry.
		const sandboxed = sandboxedPluginEntries.find((e) => e.id === pluginId);
		if (sandboxed) {
			const state = await stateRepo.enable(pluginId, sandboxed.version);
			return { success: true, data: { item: buildSandboxedPluginInfo(sandboxed, state) } };
		}

		// Runtime-installed plugin (marketplace or registry): only
		// addressable through the state row. Fall back to the existing
		// version recorded there.
		const existing = await stateRepo.get(pluginId);
		if (!existing || (existing.source !== "marketplace" && existing.source !== "registry")) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Plugin not found: ${pluginId}` },
			};
		}
		const enabled = await stateRepo.enable(pluginId, existing.version);
		return { success: true, data: { item: buildStateOnlyPluginInfo(enabled) } };
	} catch {
		return {
			success: false,
			error: {
				code: "PLUGIN_ENABLE_ERROR",
				message: "Failed to enable plugin",
			},
		};
	}
}

/**
 * Disable a plugin
 */
export async function handlePluginDisable(
	db: Kysely<Database>,
	configuredPlugins: ResolvedPlugin[],
	sandboxedPluginEntries: SandboxedPluginEntry[],
	pluginId: string,
): Promise<ApiResult<PluginResponse>> {
	try {
		const stateRepo = new PluginStateRepository(db);
		const plugin = configuredPlugins.find((p) => p.id === pluginId);

		if (plugin) {
			const state = await stateRepo.disable(pluginId, plugin.version);
			return { success: true, data: { item: buildPluginInfo(plugin, state) } };
		}

		const sandboxed = sandboxedPluginEntries.find((e) => e.id === pluginId);
		if (sandboxed) {
			const state = await stateRepo.disable(pluginId, sandboxed.version);
			return { success: true, data: { item: buildSandboxedPluginInfo(sandboxed, state) } };
		}

		const existing = await stateRepo.get(pluginId);
		if (!existing || (existing.source !== "marketplace" && existing.source !== "registry")) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Plugin not found: ${pluginId}` },
			};
		}
		const disabled = await stateRepo.disable(pluginId, existing.version);
		return { success: true, data: { item: buildStateOnlyPluginInfo(disabled) } };
	} catch {
		return {
			success: false,
			error: {
				code: "PLUGIN_DISABLE_ERROR",
				message: "Failed to disable plugin",
			},
		};
	}
}
