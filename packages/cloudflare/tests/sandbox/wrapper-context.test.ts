import { describe, expect, it, vi } from "vitest";

import { generatePluginWrapper } from "../../src/sandbox/wrapper.js";

describe("Cloudflare generated plugin context", () => {
	it("omits content and schema when their capabilities are absent", async () => {
		const source = generatePluginWrapper({
			id: "no-discovery",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: ["plugin:activate"],
			routes: [],
			admin: {},
		})
			.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
			.replace('import pluginModule from "sandbox-plugin.js";', "")
			.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
		class WorkerEntrypoint {
			constructor(readonly env: Record<string, unknown>) {}
		}
		const pluginModule = {
			hooks: {
				"plugin:activate": async (_event: unknown, ctx: Record<string, unknown>) => ({
					content: ctx.content,
					schema: ctx.schema,
				}),
			},
		};
		// eslint-disable-next-line no-implied-eval -- generated worker module is exercised in an isolated function scope
		const factory = new Function("WorkerEntrypoint", "pluginModule", source);
		const Entrypoint = factory(WorkerEntrypoint, pluginModule) as new (env: unknown) => {
			invokeHook(name: string, event: unknown): Promise<unknown>;
		};

		await expect(
			new Entrypoint({ PLUGIN_ID: "no-discovery", PLUGIN_VERSION: "1.0.0", BRIDGE: {} }).invokeHook(
				"plugin:activate",
				{},
			),
		).resolves.toEqual({ content: undefined, schema: undefined });
	});

	it("exposes schema discovery and separately gated revision methods", async () => {
		const source = generatePluginWrapper({
			id: "content-discovery",
			version: "1.0.0",
			capabilities: ["schema:read", "content:revisions:read"],
			allowedHosts: [],
			storage: {},
			hooks: ["plugin:activate"],
			routes: [],
			admin: {},
		})
			.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
			.replace('import pluginModule from "sandbox-plugin.js";', "")
			.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
		class WorkerEntrypoint {
			constructor(readonly env: Record<string, unknown>) {}
		}
		const pluginModule = {
			hooks: {
				"plugin:activate": async (_event: unknown, ctx: Record<string, any>) => ({
					collections: await ctx.schema.listCollections(),
					revisions: await ctx.content.listRevisions("posts", "post-1"),
				}),
			},
		};
		const bridge = new Proxy(
			{
				schemaListCollections: async () => [{ slug: "posts" }],
				contentListRevisions: async () => [{ id: "rev-1" }],
			},
			{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
		);
		// eslint-disable-next-line no-implied-eval -- generated worker module is exercised in an isolated function scope
		const factory = new Function("WorkerEntrypoint", "pluginModule", source);
		const Entrypoint = factory(WorkerEntrypoint, pluginModule) as new (env: unknown) => {
			invokeHook(name: string, event: unknown): Promise<unknown>;
		};
		const worker = new Entrypoint({
			PLUGIN_ID: "content-discovery",
			PLUGIN_VERSION: "1.0.0",
			BRIDGE: bridge,
		});

		await expect(worker.invokeHook("plugin:activate", {})).resolves.toEqual({
			collections: [{ slug: "posts" }],
			revisions: [{ id: "rev-1" }],
		});
	});

	it("exposes comment reads and moderation when only the implying capability is declared", async () => {
		const source = generatePluginWrapper({
			id: "comment-wrapper",
			version: "1.0.0",
			capabilities: ["comments:moderate"],
			allowedHosts: [],
			storage: {},
			hooks: ["plugin:activate"],
			routes: [],
			admin: {},
		})
			.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
			.replace('import pluginModule from "sandbox-plugin.js";', "")
			.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
		class WorkerEntrypoint {
			constructor(readonly env: Record<string, unknown>) {}
		}
		const get = vi.fn(async () => ({ id: "comment-1", status: "pending" }));
		const setStatus = vi.fn(async () => ({ id: "comment-1", status: "approved" }));
		const pluginModule = {
			hooks: {
				"plugin:activate": async (_event: unknown, ctx: Record<string, any>) => {
					await ctx.comments.get("comment-1");
					return ctx.comments.setStatus("comment-1", "approved", {
						expectedStatus: "pending",
					});
				},
			},
		};
		const bridge = new Proxy(
			{ commentGet: get, commentSetStatus: setStatus },
			{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
		);
		// eslint-disable-next-line no-implied-eval -- generated worker module is exercised in an isolated function scope
		const factory = new Function("WorkerEntrypoint", "pluginModule", source);
		const Entrypoint = factory(WorkerEntrypoint, pluginModule) as new (env: unknown) => {
			invokeHook(name: string, event: unknown): Promise<unknown>;
		};
		const worker = new Entrypoint({
			PLUGIN_ID: "comment-wrapper",
			PLUGIN_VERSION: "1.0.0",
			BRIDGE: bridge,
		});
		await expect(worker.invokeHook("plugin:activate", {})).resolves.toMatchObject({
			id: "comment-1",
			status: "approved",
		});
		expect(get).toHaveBeenCalledWith("comment-1");
		expect(setStatus).toHaveBeenCalledWith("comment-1", "approved", "pending");
	});

	it("provides cron and reconstructs a real Response", async () => {
		const source = generatePluginWrapper({
			id: "context-wrapper",
			version: "1.0.0",
			capabilities: ["network:request", "redirects:write", "redirects:read", "content:publish"],
			allowedHosts: ["api.example.com"],
			storage: {},
			hooks: ["plugin:activate"],
			routes: [],
			admin: {},
		})
			.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
			.replace('import pluginModule from "sandbox-plugin.js";', "")
			.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
		class WorkerEntrypoint {
			constructor(
				readonly env: {
					PLUGIN_ID: string;
					PLUGIN_VERSION: string;
					BRIDGE: Record<string, (...args: never[]) => unknown>;
				},
			) {}
		}
		const schedule = vi.fn();
		const pluginModule = {
			hooks: {
				"plugin:activate": async (_event: unknown, ctx: Record<string, any>) => {
					await ctx.cron.schedule("daily", { schedule: "@daily" });
					const response = await ctx.http.fetch("https://api.example.com/status");
					const versioned = await ctx.content.getVersioned("posts", "post-1");
					return {
						isResponse: response instanceof Response,
						body: await response.json(),
						redirects: await ctx.redirects.list({ limit: 1 }),
						canWriteRedirects: typeof ctx.redirects.create === "function",
						canReadTranslations: typeof ctx.content.getTranslations === "function",
						canResolvePublicUrl: typeof ctx.content.getPublicUrl === "function",
						versioned,
					};
				},
			},
		};
		const bridge = new Proxy(
			{
				cronSchedule: schedule,
				contentGetVersioned: vi.fn().mockResolvedValue({ item: { id: "post-1" }, _rev: "rev-1" }),
				httpFetch: async () => ({
					status: 200,
					headers: { "content-type": "application/json" },
					text: '{"ok":true}',
				}),
				redirectList: async () => ({
					ok: true,
					value: { items: [{ source: "/old" }], hasMore: false },
				}),
			},
			{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
		);
		// eslint-disable-next-line no-implied-eval -- generated worker module is exercised in an isolated function scope
		const factory = new Function("WorkerEntrypoint", "pluginModule", source);
		const Entrypoint = factory(WorkerEntrypoint, pluginModule) as new (env: unknown) => {
			invokeHook(name: string, event: unknown): Promise<unknown>;
		};
		const worker = new Entrypoint({
			PLUGIN_ID: "context-wrapper",
			PLUGIN_VERSION: "1.0.0",
			BRIDGE: bridge,
		});

		await expect(worker.invokeHook("plugin:activate", {})).resolves.toEqual({
			isResponse: true,
			body: { ok: true },
			redirects: { items: [{ source: "/old" }], hasMore: false },
			canWriteRedirects: true,
			canReadTranslations: true,
			canResolvePublicUrl: true,
			versioned: { item: { id: "post-1" }, _rev: "rev-1" },
		});
		expect(schedule).toHaveBeenCalledWith("daily", { schedule: "@daily" });
	});

	it("uses the explicit content-create error marker", async () => {
		const source = generatePluginWrapper({
			id: "content-create-wrapper",
			version: "1.0.0",
			capabilities: ["content:write"],
			allowedHosts: [],
			storage: {},
			hooks: ["plugin:activate"],
			routes: [],
			admin: {},
		})
			.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
			.replace('import pluginModule from "sandbox-plugin.js";', "")
			.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
		class WorkerEntrypoint {
			constructor(readonly env: Record<string, unknown>) {}
		}
		const pluginModule = {
			hooks: {
				"plugin:activate": (_event: unknown, ctx: Record<string, any>) =>
					ctx.content.create("posts", { error: "field value" }),
			},
		};
		const contentCreate = vi
			.fn()
			.mockResolvedValueOnce({
				id: "post-1",
				type: "posts",
				data: { error: "field value" },
				error: "field value",
			})
			.mockResolvedValueOnce({
				__emdashContentCreateError: true,
				error: { code: "VALIDATION_ERROR", message: "Invalid content" },
			});
		const bridge = new Proxy(
			{ contentCreate },
			{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
		);
		// eslint-disable-next-line no-implied-eval -- generated worker module is exercised in an isolated function scope
		const factory = new Function("WorkerEntrypoint", "pluginModule", source);
		const Entrypoint = factory(WorkerEntrypoint, pluginModule) as new (env: unknown) => {
			invokeHook(name: string, event: unknown): Promise<unknown>;
		};
		const worker = new Entrypoint({
			PLUGIN_ID: "content-create-wrapper",
			PLUGIN_VERSION: "1.0.0",
			BRIDGE: bridge,
		});

		await expect(worker.invokeHook("plugin:activate", {})).resolves.toMatchObject({
			id: "post-1",
			data: { error: "field value" },
		});
		await expect(worker.invokeHook("plugin:activate", {})).rejects.toMatchObject({
			name: "VALIDATION_ERROR",
			message: "Invalid content",
		});
	});

	it("passes host-attested UI context to route handlers", async () => {
		const source = generatePluginWrapper({
			id: "ui-context-wrapper",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: ["admin"],
			admin: {},
		})
			.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
			.replace('import pluginModule from "sandbox-plugin.js";', "")
			.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
		class WorkerEntrypoint {
			constructor(readonly env: Record<string, unknown>) {}
		}
		const pluginModule = {
			routes: { admin: { handler: async (route: Record<string, unknown>) => route.ui } },
		};
		// eslint-disable-next-line no-implied-eval -- generated worker module is exercised in an isolated function scope
		const factory = new Function("WorkerEntrypoint", "pluginModule", source);
		const Entrypoint = factory(WorkerEntrypoint, pluginModule) as new (env: unknown) => {
			invokeRoute(name: string, input: unknown, request: unknown): Promise<unknown>;
		};
		const worker = new Entrypoint({ PLUGIN_ID: "ui-context-wrapper", PLUGIN_VERSION: "1.0.0" });
		const ui = { surface: "admin-page", locale: "ar", direction: "rtl" };

		await expect(
			worker.invokeRoute("admin", { type: "page_load", page: "/overview" }, { ui }),
		).resolves.toEqual(ui);
	});
});
