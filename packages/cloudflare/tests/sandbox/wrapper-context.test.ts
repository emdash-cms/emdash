import { describe, expect, it, vi } from "vitest";

import { generatePluginWrapper } from "../../src/sandbox/wrapper.js";

describe("Cloudflare generated plugin context", () => {
	it("provides cron and reconstructs a real Response", async () => {
		const source = generatePluginWrapper({
			id: "context-wrapper",
			version: "1.0.0",
			capabilities: ["network:request"],
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
					return {
						isResponse: response instanceof Response,
						body: await response.json(),
					};
				},
			},
		};
		const bridge = new Proxy(
			{
				cronSchedule: schedule,
				httpFetch: async () => ({
					status: 200,
					headers: { "content-type": "application/json" },
					text: '{"ok":true}',
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
		});
		expect(schedule).toHaveBeenCalledWith("daily", { schedule: "@daily" });
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
