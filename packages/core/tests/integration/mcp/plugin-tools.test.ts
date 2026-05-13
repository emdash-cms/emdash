import { Role } from "@emdash-cms/auth";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
import {
	connectMcpHarness,
	createTestRuntime,
	extractJson,
	extractText,
	isErrorResult,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

function pluginToolName(pluginId: string, toolName: string): string {
	const readableSegments = pluginId
		.replace(/^@/, "")
		.split("/")
		.map((segment) => segment.replace(/-/g, "_"));
	const readablePluginId = readableSegments.join("__");
	if (readableSegments.some((segment) => /__/.test(segment))) {
		return `${readablePluginId}__${stableToolNameHash(pluginId)}__${toolName}`;
	}
	return `${readablePluginId}__${toolName}`;
}

function stableToolNameHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function createPluginWithMcpCapability(
	id: string = "test-plugin",
	summarize: (text: string) => string = (text) => text.toUpperCase(),
): ResolvedPlugin {
	const summarizeInput = z.object({ text: z.string() });

	return definePlugin({
		id,
		version: "1.0.0",
		capabilities: ["mcp:tools"],
		routes: {
			summarize: {
				input: summarizeInput,
				handler: async ({ input }) => {
					const { text } = summarizeInput.parse(input);
					return { summary: summarize(text) };
				},
			},
		},
		mcpTools: {
			summarize: {
				title: "Summarize Text",
				description: "Summarize text with the test plugin.",
				route: "summarize",
				input: summarizeInput,
				inputSchema: {
					type: "object",
					properties: {
						text: {
							type: "string",
							description: "Text to summarize.",
							minLength: 1,
						},
					},
					required: ["text"],
					additionalProperties: false,
				},
			},
		},
	});
}

function createPluginWithoutMcpCapability(): ResolvedPlugin {
	return {
		id: "route-only-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: {},
		routes: {
			summarize: {
				handler: async () => ({ summary: "hidden" }),
			},
		},
		mcpTools: {
			summarize: {
				description: "This tool should not be listed without the mcp:tools capability.",
				route: "summarize",
			},
		},
		admin: {},
	};
}

function createPluginWithJsonInputSchema(): ResolvedPlugin {
	return definePlugin({
		id: "json-schema-plugin",
		version: "1.0.0",
		capabilities: ["mcp:tools"],
		routes: {
			summarize: {
				handler: async ({ input }) => {
					return { input };
				},
			},
		},
		mcpTools: {
			summarize: {
				title: "Summarize Text",
				description: "Summarize text with the test plugin.",
				route: "summarize",
				inputSchema: {
					type: "object",
					properties: {
						text: {
							type: "string",
							description: "Text to summarize.",
							minLength: 1,
						},
					},
					required: ["text"],
					additionalProperties: false,
				},
			},
		},
	});
}

describe("plugin MCP tools", () => {
	let harness: McpHarness | undefined;
	let dbCleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		await dbCleanup?.();
		harness = undefined;
		dbCleanup = undefined;
	});

	async function connectWithPlugins(
		plugins: ResolvedPlugin[],
		tokenScopes?: string[],
		userRole = Role.ADMIN,
	) {
		const db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole,
			tokenScopes,
			runtimeOptions: { plugins },
		});
		dbCleanup = () => teardownTestDatabase(db);
		return harness;
	}

	it("lists enabled plugin tools that declare the mcp:tools capability", async () => {
		const connected = await connectWithPlugins([createPluginWithMcpCapability()]);

		const tools = await connected.client.listTools();
		const toolNames = tools.tools.map((tool) => tool.name);

		expect(toolNames).toContain(pluginToolName("test-plugin", "summarize"));
	});

	it("invokes plugin tools through the plugin route dispatcher", async () => {
		const connected = await connectWithPlugins([createPluginWithMcpCapability()]);

		const result = await connected.client.callTool({
			name: pluginToolName("test-plugin", "summarize"),
			arguments: { text: "hello" },
		});

		expect(result.isError).toBeFalsy();
		expect(extractJson(result)).toEqual({ summary: "HELLO" });
	});

	it("does not list plugin tools without the mcp:tools capability", async () => {
		const connected = await connectWithPlugins([createPluginWithoutMcpCapability()]);

		const tools = await connected.client.listTools();
		const toolNames = tools.tools.map((tool) => tool.name);

		expect(toolNames).not.toContain(pluginToolName("route-only-plugin", "summarize"));
	});

	it("keeps plugin tool names distinct for colliding readable plugin IDs", async () => {
		const scopedName = pluginToolName("@foo/bar", "summarize");
		const dashedName = pluginToolName("foo--bar", "summarize");
		const connected = await connectWithPlugins([
			createPluginWithMcpCapability("@foo/bar", (text) => `scoped:${text}`),
			createPluginWithMcpCapability("foo--bar", (text) => `dashed:${text}`),
		]);

		const tools = await connected.client.listTools();
		const toolNames = tools.tools.map((tool) => tool.name);

		expect(scopedName).not.toBe(dashedName);
		expect(toolNames).toContain(scopedName);
		expect(toolNames).toContain(dashedName);

		const scopedResult = await connected.client.callTool({
			name: scopedName,
			arguments: { text: "hello" },
		});
		const dashedResult = await connected.client.callTool({
			name: dashedName,
			arguments: { text: "hello" },
		});

		expect(extractJson(scopedResult)).toEqual({ summary: "scoped:hello" });
		expect(extractJson(dashedResult)).toEqual({ summary: "dashed:hello" });
	});

	it("uses readable double-underscore names for scoped plugin IDs", async () => {
		const connected = await connectWithPlugins([
			createPluginWithMcpCapability("@emdash-cms/plugin-forms"),
		]);

		const tools = await connected.client.listTools();
		const toolNames = tools.tools.map((tool) => tool.name);

		expect(toolNames).toContain("emdash_cms__plugin_forms__summarize");
	});

	it("exposes JSON input schemas for plugin tools", async () => {
		const connected = await connectWithPlugins([createPluginWithJsonInputSchema()]);

		const tools = await connected.client.listTools();
		const tool = tools.tools.find(
			(entry) => entry.name === pluginToolName("json-schema-plugin", "summarize"),
		);

		expect(tool?.inputSchema).toMatchObject({
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "Text to summarize.",
					minLength: 1,
				},
			},
			required: ["text"],
			additionalProperties: false,
		});
	});

	it("validates plugin tool calls with JSON input schemas", async () => {
		const connected = await connectWithPlugins([createPluginWithJsonInputSchema()]);

		const result = await connected.client.callTool({
			name: pluginToolName("json-schema-plugin", "summarize"),
			arguments: {},
		});

		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("Input validation error");
		expect(extractText(result)).toContain("text");
	});

	it("does not list sandboxed plugin tools when the plugin is not loaded", async () => {
		const db = await setupTestDatabaseWithCollections();
		dbCleanup = () => teardownTestDatabase(db);
		const runtime = createTestRuntime(db, {
			enabledPluginIds: ["sandbox-plugin"],
			sandboxedPluginEntries: [
				{
					id: "sandbox-plugin",
					version: "1.0.0",
					options: {},
					code: "export default {};",
					capabilities: ["mcp:tools"],
					allowedHosts: [],
					storage: {},
					mcpTools: [
						{
							name: "summarize",
							description: "Summarize text.",
							route: "summarize",
						},
					],
				},
			],
		});

		expect(runtime.getPluginMcpTools()).toEqual([]);
	});

	it("exposes JSON input schemas for sandboxed plugin tools", async () => {
		const db = await setupTestDatabaseWithCollections();
		dbCleanup = () => teardownTestDatabase(db);
		const connected = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
			runtimeOptions: {
				enabledPluginIds: ["sandbox-plugin"],
				sandboxedPlugins: new Map([
					[
						"sandbox-plugin:1.0.0",
						{
							id: "sandbox-plugin:1.0.0",
							invokeHook: async () => undefined,
							invokeRoute: async () => ({ ok: true }),
							terminate: async () => undefined,
						},
					],
				]),
				sandboxedPluginEntries: [
					{
						id: "sandbox-plugin",
						version: "1.0.0",
						options: {},
						code: "export default {};",
						capabilities: ["mcp:tools"],
						allowedHosts: [],
						storage: {},
						mcpTools: [
							{
								name: "summarize",
								description: "Summarize text.",
								route: "summarize",
								inputSchema: {
									type: "object",
									properties: {
										text: {
											type: "string",
											description: "Text to summarize.",
										},
									},
									required: ["text"],
									additionalProperties: false,
								},
							},
						],
					},
				],
			},
		});
		harness = connected;

		const tools = await connected.client.listTools();
		const tool = tools.tools.find(
			(entry) => entry.name === pluginToolName("sandbox-plugin", "summarize"),
		);

		expect(tool?.inputSchema).toMatchObject({
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "Text to summarize.",
				},
			},
			required: ["text"],
			additionalProperties: false,
		});
	});

	it("requires admin token scope to call plugin tools", async () => {
		const connected = await connectWithPlugins([createPluginWithMcpCapability()], ["content:read"]);

		const result = await connected.client.callTool({
			name: pluginToolName("test-plugin", "summarize"),
			arguments: { text: "hello" },
		});

		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("[INSUFFICIENT_SCOPE]");
	});

	it("requires ADMIN role to call plugin tools even with admin token scope", async () => {
		const connected = await connectWithPlugins(
			[createPluginWithMcpCapability()],
			["admin"],
			Role.EDITOR,
		);

		const result = await connected.client.callTool({
			name: pluginToolName("test-plugin", "summarize"),
			arguments: { text: "hello" },
		});

		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("[INSUFFICIENT_PERMISSIONS]");
	});
});
