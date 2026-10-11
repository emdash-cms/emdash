import { randomUUID } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { WorkerdSandboxRunner } from "../../../../workerd/src/sandbox/runner.js";
import { GET as getPlugin } from "../../../src/astro/routes/api/admin/plugins/[id]/index.js";
import { GET as listPlugins } from "../../../src/astro/routes/api/admin/plugins/index.js";
import { EmDashRuntime, type SandboxedPluginEntry } from "../../../src/emdash-runtime.js";
import { adaptSandboxEntry } from "../../../src/plugins/adapt-sandbox-entry.js";

function pluginEntry(): SandboxedPluginEntry {
	return {
		id: "@acme/calendar",
		version: "1.0.0",
		options: {},
		code: "export default { routes: { events: async () => ({}) } };",
		capabilities: ["content:read"],
		hooks: [],
		allowedHosts: [],
		storage: {},
		routes: [{ name: "events", permission: "content:read", methods: ["POST"] }],
		mcp: {
			tools: ["broken", "listEvents"].map((name) => ({
				name,
				description: "List calendar events.",
				route: "events",
				permission: "content:read",
				destructive: false,
				inputSchema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			})),
		},
	};
}

describe.each(["sandboxed", "built"] as const)("%s plugin MCP registration", (format) => {
	let activeRuntime: EmDashRuntime | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await activeRuntime?.shutdown();
		await activeRuntime?.db.destroy();
	});

	async function runtimeFor(entry: SandboxedPluginEntry) {
		const plugin = adaptSandboxEntry(
			{
				routes: {
					events: {
						permission: "content:read",
						methods: ["POST"],
						handler: async () => ({}),
					},
				},
			},
			{ ...entry, entrypoint: "@acme/calendar", format: "standard" },
		);
		activeRuntime = await EmDashRuntime.create({
			config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
			plugins: format === "built" ? [plugin] : [],
			createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
			createStorage: null,
			sandboxEnabled: format === "sandboxed",
			sandboxedPluginEntries: format === "sandboxed" ? [entry] : [],
			createSandboxRunner: (options) => new WorkerdSandboxRunner(options),
		});
		return activeRuntime;
	}

	it.each(["inputSchema", "outputSchema"] as const)(
		"keeps other tools available after an unreadable %s",
		async (schemaKind) => {
			const entry = pluginEntry();
			entry.mcp!.tools[0]![schemaKind] = {
				type: "object",
				properties: { title: { $ref: "#/$defs/missing" } },
			};
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runtime = await runtimeFor(entry);
			expect(warn).not.toHaveBeenCalled();

			const tools = await runtime.getPluginMcpTools();
			expect(tools.map((tool) => tool.name)).toEqual(["broken", "listEvents"]);
			expect(tools[1]!.inputSchema.safeParse({ title: 42 }).success).toBe(false);
			expect(tools[1]!.inputSchema.safeParse({ title: "Launch" }).success).toBe(true);
			if (schemaKind === "inputSchema") {
				expect(tools[0]!.inputSchema.parse({ unexpected: true })).toEqual({ unexpected: true });
			} else {
				expect(tools[0]!.outputSchema).toBeUndefined();
			}
			expect(warn).toHaveBeenCalled();
		},
	);

	it("includes the generated MCP name in both admin plugin responses", async () => {
		const runtime = await runtimeFor(pluginEntry());
		const context = {
			locals: { emdash: runtime, user: { id: "admin", role: Role.ADMIN } },
			params: { id: "@acme/calendar" },
			request: new Request("https://example.test/_emdash/api/admin/plugins"),
		} as unknown as APIContext;
		const expected = expect.objectContaining({
			id: "@acme/calendar",
			mcpTools: expect.arrayContaining([
				expect.objectContaining({ name: "listEvents", mcpName: "acme__calendar__listEvents" }),
			]),
		});
		const list = await listPlugins(context);
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({
			data: { items: expect.arrayContaining([expected]) },
		});
		const single = await getPlugin(context);
		expect(single.status).toBe(200);
		expect(await single.json()).toMatchObject({ data: { item: expected } });
	});
});
