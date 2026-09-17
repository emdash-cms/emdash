import { describe, expect, it, vi } from "vitest";

import {
	PLUGIN_HTTP_FORM_BYTES,
	PLUGIN_HTTP_FORM_CONTENT_TYPE,
	pluginHttpFormBody,
} from "../../../core/tests/fixtures/plugin-http.js";
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
					const response = await ctx.http.fetch("https://api.example.com/status", {
						method: "POST",
						body: pluginHttpFormBody(),
					});
					return {
						isResponse: response instanceof Response,
						body: await response.json(),
					};
				},
			},
		};
		let capturedInit: RequestInit | undefined;
		const bridge = new Proxy(
			{
				cronSchedule: schedule,
				httpFetch: async (_url: string, init?: RequestInit) => {
					capturedInit = init;
					return {
						status: 200,
						statusText: "OK",
						headers: [["content-type", "application/json"]],
						finalUrl: "https://api.example.com/status",
						redirected: false,
						body: new TextEncoder().encode('{"ok":true}'),
					};
				},
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
		expect(new Headers(capturedInit?.headers).get("content-type")).toBe(
			PLUGIN_HTTP_FORM_CONTENT_TYPE,
		);
		expect(capturedInit?.body).toEqual(PLUGIN_HTTP_FORM_BYTES);
	});
});
