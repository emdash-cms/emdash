import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";

function createDeps(onActivate: (hasCron: boolean) => void): RuntimeDependencies {
	const entrypoint = `test-plugin-cron-route-${randomUUID()}`;
	return {
		config: { database: { entrypoint, config: {}, type: "sqlite" } },
		plugins: [
			definePlugin({
				id: "cron-route",
				version: "1.0.0",
				routes: {
					status: { handler: async (ctx) => ({ hasCron: !!ctx.cron }) },
				},
				hooks: {
					"plugin:activate": {
						handler: async (_event, ctx) => onActivate(!!ctx.cron),
					},
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createScheduler: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

describe("EmDashRuntime.handlePluginApiRoute — cron", () => {
	it("provides database-backed cron access without an in-process scheduler", async () => {
		let activateHasCron = false;
		const runtime = await EmDashRuntime.create(
			createDeps((hasCron) => {
				activateHasCron = hasCron;
			}),
		);
		try {
			const result = await runtime.handlePluginApiRoute(
				"cron-route",
				"GET",
				"/status",
				new Request("http://test.local/_emdash/api/plugins/cron-route/status"),
			);
			expect(result).toMatchObject({ success: true, data: { hasCron: true } });

			await runtime.setPluginStatus("cron-route", "inactive");
			await runtime.setPluginStatus("cron-route", "active");
			expect(activateHasCron).toBe(true);
		} finally {
			await runtime.stopCron();
		}
	});
});
