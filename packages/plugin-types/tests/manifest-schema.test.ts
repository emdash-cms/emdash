import { describe, expect, it } from "vitest";

import { pluginManifestSchema } from "../src/manifest-schema.js";

describe("pluginManifestSchema", () => {
	it("accepts publication policy hooks only with the current manifest vocabulary", () => {
		const result = pluginManifestSchema.parse({
			id: "publication-policy",
			version: "1.0.0",
			declaredAccess: { content: { policy: {} } },
			capabilities: ["hooks.content-policy:register"],
			allowedHosts: [],
			storage: {},
			hooks: ["content:beforePublish", "content:beforeSchedule", "content:beforeUnpublish"],
			routes: [],
			admin: {},
		});

		expect(result.declaredAccess).toEqual({ content: { policy: {} } });
		expect(result.hooks).toEqual([
			"content:beforePublish",
			"content:beforeSchedule",
			"content:beforeUnpublish",
		]);
	});

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
			},
		});

		expect(result.routes).toEqual([
			{
				name: "events/list",
				public: true,
				permission: "content:read",
				cacheControl: "public, max-age=60",
			},
		]);
		expect(result.mcp?.tools[0]).toMatchObject({
			name: "listEvents",
			permission: "content:read",
			outputSchema: { type: "array" },
		});
		expect(result.admin.fieldWidgets?.[0]?.name).toBe("event-picker");
	});
});
