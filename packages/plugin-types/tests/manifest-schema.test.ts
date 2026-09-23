import { describe, expect, it } from "vitest";

import { pluginManifestSchema } from "../src/manifest-schema.js";

describe("pluginManifestSchema", () => {
	it("reconciles comment moderation as implying personal-data reads", () => {
		const result = pluginManifestSchema.parse({
			id: "comment-shield",
			version: "1.0.0",
			declaredAccess: { comments: { moderate: {} } },
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [],
			admin: {},
		});
		expect(result.declaredAccess).toEqual({ comments: { moderate: {} } });
	});

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
				{ name: "events/json", permission: "content:read" },
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
				{ name: "entry-panel", permission: "content:edit_own" },
				{ name: "entry-action", permission: "content:edit_own" },
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
				editorPanels: [
					{
						id: "health",
						title: "Health",
						route: "entry-panel",
						collections: ["posts"],
						draft: { read: { translatable: true }, patch: { fields: ["title"] } },
					},
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

		expect(result.routes).toEqual([
			{ name: "events/json", permission: "content:read" },
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
			{ name: "entry-panel", permission: "content:edit_own" },
			{ name: "entry-action", permission: "content:edit_own" },
		]);
		expect(result.mcp?.tools[0]).toMatchObject({
			name: "listEvents",
			permission: "content:read",
			outputSchema: { type: "array" },
		});
		expect(result.admin.fieldWidgets?.[0]?.name).toBe("event-picker");
		expect(result.admin.editorPanels?.[0]?.route).toBe("entry-panel");
		expect(result.admin.editorPanels?.[0]?.draft?.patch).toEqual({ fields: ["title"] });
		expect(result.admin.editorActions?.[0]?.confirm?.confirm).toBe("Repair");
	});

	it.each([
		["missing route", ["entry-panel"], "missing"],
		["public route", [{ name: "entry-panel", public: true }], "entry-panel"],
		["duplicate route", ["entry-panel", { name: "entry-panel" }], "entry-panel"],
		["raw response route", [{ name: "entry-panel", response: "raw" }], "entry-panel"],
		["GET-only route", [{ name: "entry-panel", methods: ["GET"] }], "entry-panel"],
		["form-data route", [{ name: "entry-panel", request: { body: "form-data" } }], "entry-panel"],
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

	it("rejects duplicate route names before Block Kit admin validation", () => {
		const result = pluginManifestSchema.safeParse({
			id: "calendar",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: ["admin", { name: "admin", public: true }],
			admin: { pages: [{ path: "/overview", label: "Overview" }] },
		});
		expect(result.success).toBe(false);
	});

	it.each([
		{ response: "raw" },
		{ methods: ["GET"] },
		{ request: { body: "none" } },
		{ request: { body: "form-data" } },
	])("rejects an incompatible explicit Block Kit admin route %#", (route) => {
		const result = pluginManifestSchema.safeParse({
			id: "calendar",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [{ name: "admin", ...route }],
			admin: { pages: [{ path: "/overview", label: "Overview" }] },
		});
		expect(result.success).toBe(false);
	});

	it.each([
		{ methods: ["GET"] },
		{ request: { body: "none" } },
		{ request: { body: "form-data" } },
		{ response: "raw" },
	])("rejects an MCP tool with an incompatible route %#", (route) => {
		const result = pluginManifestSchema.safeParse({
			id: "calendar",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [{ name: "tool", permission: "plugins:manage", ...route }],
			mcp: {
				tools: [
					{
						name: "calendarTool",
						description: "Manage the calendar.",
						route: "tool",
						permission: "plugins:manage",
						destructive: false,
						inputSchema: { type: "object" },
					},
				],
			},
			admin: {},
		});
		expect(result.success).toBe(false);
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
