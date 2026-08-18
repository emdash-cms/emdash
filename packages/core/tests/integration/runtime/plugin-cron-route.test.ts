import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { createPublicPluginApiRouteHandler } from "../../../src/astro/public-plugin-api-routes.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";

function createDeps(onActivate: (hasCron: boolean) => void): RuntimeDependencies {
	const entrypoint = `test-plugin-cron-route-${randomUUID()}`;
	return {
		config: { database: { entrypoint, config: {}, type: "sqlite" } },
		plugins: [
			definePlugin({
				id: "cron-route",
				version: "1.0.0",
				capabilities: ["content:write"],
				routes: {
					status: { public: true, handler: async (ctx) => ({ hasCron: !!ctx.cron }) },
					write: {
						public: true,
						handler: async (ctx) => {
							if (!ctx.content || !("create" in ctx.content)) {
								throw new Error("Content write access unavailable");
							}
							return ctx.content.create("posts", { slug: "plugin-write" });
						},
					},
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

	it("keeps public plugin reads query-free and fences only actual content writes", async () => {
		const runtime = await EmDashRuntime.create(createDeps(() => undefined));
		try {
			await runtime.db
				.updateTable("_emdash_media_usage_activation")
				.set({ state: "activating" })
				.where("task_key", "=", "incremental_capture")
				.execute();
			const handler = createPublicPluginApiRouteHandler(runtime);
			const metrics = createRequestMetrics(performance.now());

			const readResult = await runWithContext({ editMode: false, metrics }, async () =>
				handler("cron-route", "GET", "/status", new Request("http://test.local/page")),
			);
			expect(readResult).toMatchObject({ success: true, data: { hasCron: true } });
			expect(metrics.dbCount).toBe(0);

			const writeResult = await handler(
				"cron-route",
				"GET",
				"/write",
				new Request("http://test.local/page"),
			);

			expect(writeResult).toMatchObject({
				success: false,
				status: 503,
				error: { code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS" },
			});
		} finally {
			await runtime.stopCron();
		}
	});
});
