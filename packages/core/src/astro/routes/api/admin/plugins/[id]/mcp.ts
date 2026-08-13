import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess } from "#api/error.js";
import { parseBody } from "#api/parse.js";
import { PluginStateRepository } from "#plugins/state.js";

export const prerender = false;

const bodySchema = z.object({ enabled: z.boolean() });

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requirePerm(user, "plugins:manage");
	if (denied) return denied;
	if (!params.id) return apiError("INVALID_REQUEST", "Plugin ID required", 400);

	const parsed = await parseBody(request, bodySchema);
	if (parsed instanceof Response) return parsed;
	const tools = await emdash.getPluginMcpTools(params.id);
	if (parsed.enabled && tools.length === 0) {
		return apiError("NO_MCP_TOOLS", "Plugin does not declare MCP tools", 400);
	}
	const stateRepo = new PluginStateRepository(emdash.db);
	const existing = await stateRepo.get(params.id);
	const configuredVersion =
		emdash.configuredPlugins.find((plugin) => plugin.id === params.id)?.version ??
		emdash.sandboxedPluginEntries.find((plugin) => plugin.id === params.id)?.version;
	const version = existing?.version ?? configuredVersion;
	if (!version) return apiError("NOT_FOUND", "Plugin not found", 404);
	const consent = parsed.enabled ? emdash.serializePluginMcpConsent(tools, params.id) : null;
	const item = await stateRepo.upsert(params.id, version, existing?.status ?? "active", {
		mcpToolsEnabled: parsed.enabled,
		mcpToolsConsent: consent,
	});
	return apiSuccess({
		enabled: item.mcpToolsEnabled,
		tools: tools.map(({ inputSchema: _, outputSchema: __, ...tool }) => tool),
	});
};
