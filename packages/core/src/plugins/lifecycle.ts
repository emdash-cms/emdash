import type { Kysely } from "kysely";

import { handlePluginDisable, handlePluginEnable } from "../api/handlers/plugins.js";
import type { Database } from "../database/types.js";
import type { SandboxedPluginEntry } from "../emdash-runtime.js";
import { setCronTasksEnabled } from "./cron.js";
import type { ResolvedPlugin } from "./types.js";

export interface PluginLifecycleRuntime {
	db: Kysely<Database>;
	configuredPlugins: ResolvedPlugin[];
	sandboxedPluginEntries: SandboxedPluginEntry[];
	setPluginStatus(pluginId: string, status: "active" | "inactive"): Promise<void>;
	syncMarketplacePlugins(): Promise<void>;
	syncRegistryPlugins(): Promise<void>;
}

export async function enableRuntimePlugin(runtime: PluginLifecycleRuntime, pluginId: string) {
	const result = await handlePluginEnable(
		runtime.db,
		runtime.configuredPlugins,
		runtime.sandboxedPluginEntries,
		pluginId,
	);
	if (!result.success) return result;

	const source = result.data.item.source;
	if (source === "registry") await runtime.syncRegistryPlugins();
	else if (source === "marketplace") await runtime.syncMarketplacePlugins();
	await runtime.setPluginStatus(pluginId, "active");
	await setCronTasksEnabled(runtime.db, pluginId, true);
	return result;
}

export async function disableRuntimePlugin(runtime: PluginLifecycleRuntime, pluginId: string) {
	const result = await handlePluginDisable(
		runtime.db,
		runtime.configuredPlugins,
		runtime.sandboxedPluginEntries,
		pluginId,
	);
	if (!result.success) return result;

	await runtime.setPluginStatus(pluginId, "inactive");
	await setCronTasksEnabled(runtime.db, pluginId, false);
	return result;
}
