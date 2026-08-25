import { describe, expect, it } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

async function buildRuntime() {
	const db = await setupTestDatabase();
	const plugin = definePlugin({
		id: "site-aware-route",
		version: "1.0.0",
		routes: {
			inspect: {
				handler: async (ctx) => ({
					site: ctx.site,
					url: ctx.url("/checkout/success"),
				}),
			},
		},
	});
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = {
		db,
		siteInfo: {
			siteName: "Example Site",
			siteUrl: "https://example.com/",
			locale: "nl",
		},
	} as const;
	const hooks = createHookPipeline([plugin], pipelineFactoryOptions);
	const pipelineRef = { current: hooks };
	const runtimeDeps: RuntimeDependencies = {
		config,
		plugins: [plugin],
		createDialect: () => {
			throw new Error("createDialect not used in this test");
		},
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	const runtime = new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: [plugin],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set([plugin.id]),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [plugin],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef,
	});
	return { db, runtime };
}

describe("EmDashRuntime.handlePluginApiRoute site context", () => {
	it("passes configured site information to trusted plugin routes", async () => {
		const { db, runtime } = await buildRuntime();
		try {
			const result = await runtime.handlePluginApiRoute(
				"site-aware-route",
				"GET",
				"/inspect",
				new Request("https://admin.example.com/_emdash/api/plugin/site-aware-route/inspect"),
			);

			expect(result).toMatchObject({
				success: true,
				data: {
					site: {
						name: "Example Site",
						url: "https://example.com",
						locale: "nl",
						trailingSlash: "ignore",
					},
					url: "https://example.com/checkout/success",
				},
			});
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
