import { describe, expect, it } from "vitest";

import { pluginManifestSchema } from "../src/manifest-schema.js";

describe("pluginManifestSchema", () => {
	it("accepts schema and separately consented revision reads", () => {
		const result = pluginManifestSchema.parse({
			id: "content-audit",
			version: "1.0.0",
			declaredAccess: {
				content: { revisionsRead: {} },
				schema: { read: {} },
			},
			capabilities: ["content:revisions:read", "schema:read"],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [],
			admin: {},
		});

		expect(result.declaredAccess).toEqual({
			content: { revisionsRead: {} },
			schema: { read: {} },
		});
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
