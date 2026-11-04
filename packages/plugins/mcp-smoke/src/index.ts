import type { PluginDescriptor } from "emdash";

export function mcpSmokePlugin(): PluginDescriptor {
	return {
		id: "mcp-smoke",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-mcp-smoke/sandbox",
		options: {},
	};
}
