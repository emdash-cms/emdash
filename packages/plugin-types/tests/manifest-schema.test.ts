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
				"events/json",
				{
					name: "events/list",
					public: true,
					permission: "content:read",
					cacheControl: "public, max-age=60",
					methods: ["POST"],
					request: {
						body: "bytes",
						maxBytes: 4096,
						headers: ["x-webhook-signature"],
					},
					response: "raw",
				},
			],
			mcp: {
				tools: [
					{
						name: "listEvents",
						description: "List calendar events.",
						route: "events/json",
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
			"events/json",
			{
				name: "events/list",
				public: true,
				permission: "content:read",
				cacheControl: "public, max-age=60",
				methods: ["POST"],
				request: {
					body: "bytes",
					maxBytes: 4096,
					headers: ["x-webhook-signature"],
				},
				response: "raw",
			},
		]);
		expect(result.mcp?.tools[0]).toMatchObject({
			name: "listEvents",
			permission: "content:read",
			outputSchema: { type: "array" },
		});
		expect(result.admin.fieldWidgets?.[0]?.name).toBe("event-picker");
	});

	it.each([
		{ methods: ["post"] },
		{ methods: ["POST", "POST"] },
		{ request: { body: "bytes", maxBytes: 8 * 1024 * 1024 + 1 } },
		{ request: { body: "none", maxBytes: 1 } },
		{ request: { body: "text", headers: ["authorization"] } },
		{ request: { body: "text", headers: ["cf-access-authenticated-user-email"] } },
		{ request: { body: "text", headers: ["cf-access-token"] } },
	])("rejects an unsafe raw-route declaration %#", (route) => {
		const result = pluginManifestSchema.safeParse({
			id: "calendar",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [{ name: "webhook", ...route }],
			admin: {},
		});
		expect(result.success).toBe(false);
	});
});
