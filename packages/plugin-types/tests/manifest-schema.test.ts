import { describe, expect, it } from "vitest";

import { pluginManifestSchema } from "../src/manifest-schema.js";

describe("pluginManifestSchema", () => {
	it("preserves route authorization, cache, MCP, and declarative admin metadata", () => {
		const result = pluginManifestSchema.parse({
			id: "calendar",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [
				{
					name: "events/list",
					public: true,
					permission: "content:read",
					cacheControl: "public, max-age=60",
				},
				{ name: "entry-panel", permission: "content:edit_own" },
				{ name: "entry-action", permission: "content:edit_own" },
			],
			mcp: {
				tools: [
					{
						name: "listEvents",
						description: "List calendar events.",
						route: "events/list",
						permission: "content:read",
						destructive: false,
						inputSchema: { type: "object" },
						outputSchema: { type: "array" },
					},
				],
			},
			admin: {
				settingsSchema: {
					enabled: { type: "boolean", label: "Enabled", default: true },
				},
				fieldWidgets: [
					{
						name: "event-picker",
						label: "Event",
						fieldTypes: ["string"],
						elements: [{ type: "input", action_id: "event" }],
					},
				],
				editorPanels: [
					{ id: "health", title: "Health", route: "entry-panel", collections: ["posts"] },
				],
				editorActions: [
					{
						id: "repair",
						label: "Repair",
						route: "entry-action",
						placement: "overflow",
						style: "danger",
						confirm: { title: "Repair?", text: "Change entry", confirm: "Repair", deny: "Cancel" },
					},
				],
			},
		});

		expect(result.routes[0]).toEqual({
			name: "events/list",
			public: true,
			permission: "content:read",
			cacheControl: "public, max-age=60",
		});
		expect(result.mcp?.tools[0]).toMatchObject({
			name: "listEvents",
			permission: "content:read",
			outputSchema: { type: "array" },
		});
		expect(result.admin.fieldWidgets?.[0]?.name).toBe("event-picker");
		expect(result.admin.editorPanels?.[0]?.route).toBe("entry-panel");
		expect(result.admin.editorActions?.[0]?.confirm?.confirm).toBe("Repair");
	});

	it.each([
		["missing route", ["entry-panel"], "missing"],
		["public route", [{ name: "entry-panel", public: true }], "entry-panel"],
		["duplicate route", ["entry-panel", { name: "entry-panel" }], "entry-panel"],
	])("rejects an editor extension with a %s", (_label, routes, route) => {
		const result = pluginManifestSchema.safeParse({
			id: "calendar",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes,
			admin: { editorPanels: [{ id: "health", title: "Health", route }] },
		});
		expect(result.success).toBe(false);
	});
});
