/**
 * Plugin management list endpoint
 *
 * GET /_emdash/api/admin/plugins - List all configured plugins with state
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handlePluginList } from "#api/index.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	const result = await handlePluginList(
		emdash.db,
		emdash.configuredPlugins,
		emdash.sandboxedPluginEntries,
		emdash.config.marketplace,
		(pluginId) => emdash.getRuntimePluginSettingsSchema(pluginId),
	);
	if (result.success) {
		const tools = await emdash.getPluginMcpTools();
		for (const item of result.data.items) {
			item.mcpTools = tools
				.filter((tool) => tool.pluginId === item.id)
				.map(({ inputSchema: _, outputSchema: __, pluginId: ___, ...tool }) => tool);
		}
	}

	return unwrapResult(result);
};
