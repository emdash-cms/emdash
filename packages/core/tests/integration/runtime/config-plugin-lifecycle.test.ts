import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import type { PluginContext } from "../../../src/plugins/types.js";

const PLUGIN_ID = "config-lifecycle";

interface LifecycleHandlers {
	install?: (ctx: PluginContext) => Promise<void>;
	activate?: (ctx: PluginContext) => Promise<void>;
}

function createDeps(entrypoint: string, handlers: LifecycleHandlers): RuntimeDependencies {
	return {
		config: {
			database: {
				entrypoint,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [
			definePlugin({
				id: PLUGIN_ID,
				version: "1.0.0",
				hooks: {
					"plugin:install": async (_event, ctx) => {
						await handlers.install?.(ctx);
					},
					"plugin:activate": async (_event, ctx) => {
						await handlers.activate?.(ctx);
					},
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

describe("EmDashRuntime.create — config plugin lifecycle", () => {
	const runtimes: EmDashRuntime[] = [];

	async function boot(entrypoint: string, handlers: LifecycleHandlers): Promise<EmDashRuntime> {
		const runtime = await EmDashRuntime.create(createDeps(entrypoint, handlers));
		runtimes.push(runtime);
		return runtime;
	}

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) {
			await runtime.stopCron();
		}
	});

	it("runs install and activate for a new config-registered plugin", async () => {
		let installRan = false;
		let activateRan = false;

		const runtime = await boot(`test-config-plugin-lifecycle-${randomUUID()}`, {
			install: async () => {
				installRan = true;
			},
			activate: async (ctx) => {
				activateRan = true;
				await ctx.cron?.schedule("daily", { schedule: "0 6 * * *" });
			},
		});

		expect(installRan).toBe(true);
		expect(activateRan).toBe(true);

		const state = await new PluginStateRepository(runtime.db).get(PLUGIN_ID);
		expect(state).toMatchObject({
			pluginId: PLUGIN_ID,
			status: "active",
			version: "1.0.0",
			source: "config",
		});

		const task = await runtime.db
			.selectFrom("_emdash_cron_tasks")
			.select("task_name")
			.where("plugin_id", "=", PLUGIN_ID)
			.executeTakeFirst();
		expect(task?.task_name).toBe("daily");
	});

	it("does not run the lifecycle again on a later boot", async () => {
		const entrypoint = `test-config-plugin-lifecycle-${randomUUID()}`;
		let installs = 0;
		let activations = 0;
		const handlers: LifecycleHandlers = {
			install: async () => {
				installs++;
			},
			activate: async () => {
				activations++;
			},
		};

		const first = await boot(entrypoint, handlers);
		const stateAfterFirstBoot = await new PluginStateRepository(first.db).get(PLUGIN_ID);

		const second = await boot(entrypoint, handlers);

		expect(installs).toBe(1);
		expect(activations).toBe(1);
		expect(await new PluginStateRepository(second.db).get(PLUGIN_ID)).toEqual(stateAfterFirstBoot);
	});

	it("runs install once when isolates boot concurrently", async () => {
		const entrypoint = `test-config-plugin-lifecycle-${randomUUID()}`;
		let installs = 0;
		const handlers: LifecycleHandlers = {
			install: async () => {
				installs++;
			},
		};

		await Promise.all([boot(entrypoint, handlers), boot(entrypoint, handlers)]);

		expect(installs).toBe(1);
	});

	it("disables a plugin whose install hook fails, without running activate", async () => {
		const entrypoint = `test-config-plugin-lifecycle-${randomUUID()}`;
		let installs = 0;
		let activations = 0;
		const handlers: LifecycleHandlers = {
			install: async () => {
				installs++;
				throw new Error("install failed");
			},
			activate: async () => {
				activations++;
			},
		};

		const runtime = await boot(entrypoint, handlers);

		expect(activations).toBe(0);
		expect(runtime.hooks.hasHooks("plugin:activate")).toBe(false);
		const state = await new PluginStateRepository(runtime.db).get(PLUGIN_ID);
		expect(state?.status).toBe("inactive");

		await boot(entrypoint, handlers);
		expect(installs).toBe(1);
	});

	it("disables a plugin whose activate hook fails, along with the cron tasks it scheduled", async () => {
		const runtime = await boot(`test-config-plugin-lifecycle-${randomUUID()}`, {
			activate: async (ctx) => {
				await ctx.cron?.schedule("daily", { schedule: "0 6 * * *" });
				throw new Error("activate failed");
			},
		});

		expect(runtime.hooks.hasHooks("plugin:activate")).toBe(false);
		const state = await new PluginStateRepository(runtime.db).get(PLUGIN_ID);
		expect(state?.status).toBe("inactive");

		const task = await runtime.db
			.selectFrom("_emdash_cron_tasks")
			.select("enabled")
			.where("plugin_id", "=", PLUGIN_ID)
			.executeTakeFirst();
		expect(task?.enabled).toBe(0);
	});
});
