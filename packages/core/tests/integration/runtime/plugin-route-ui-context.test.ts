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
		id: "trusted-block-kit",
		version: "1.0.0",
		admin: {
			pages: [{ path: "overview", label: "Overview" }],
			widgets: [{ id: "status", title: "Status" }],
		},
		routes: {
			admin: {
				handler: async (ctx) => ({ blocks: [], ui: ctx.ui ?? null }),
			},
			inspect: {
				handler: async (ctx) => ({ ui: ctx.ui ?? null }),
			},
		},
	});
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([plugin], pipelineFactoryOptions);
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
		pipelineRef: { current: hooks },
	});
	return { db, runtime };
}

function blockKitRequest(page: string, cookie?: string) {
	return new Request("https://example.test/_emdash/api/plugins/trusted-block-kit/admin", {
		method: "POST",
		headers: cookie ? { Cookie: cookie } : {},
		body: JSON.stringify({ type: "page_load", page }),
	});
}

describe("EmDashRuntime.handlePluginApiRoute UI context for trusted plugins", () => {
	it("passes the admin locale and direction to a declared Block Kit page", async () => {
		const { db, runtime } = await buildRuntime();
		try {
			const result = await runtime.handlePluginApiRoute(
				"trusted-block-kit",
				"POST",
				"/admin",
				blockKitRequest("/overview", "emdash-locale=ar"),
			);

			expect(result).toMatchObject({
				success: true,
				data: { ui: { surface: "admin-page", locale: "ar", direction: "rtl" } },
			});
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("passes the dashboard-widget surface to a declared widget", async () => {
		const { db, runtime } = await buildRuntime();
		try {
			const result = await runtime.handlePluginApiRoute(
				"trusted-block-kit",
				"POST",
				"/admin",
				blockKitRequest("widget:status"),
			);

			expect(result).toMatchObject({
				success: true,
				data: { ui: { surface: "dashboard-widget", locale: "en", direction: "ltr" } },
			});
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("serves a page the plugin did not declare, without UI context", async () => {
		const { db, runtime } = await buildRuntime();
		try {
			const result = await runtime.handlePluginApiRoute(
				"trusted-block-kit",
				"POST",
				"/admin",
				blockKitRequest("/not-declared", "emdash-locale=ar"),
			);

			expect(result).toMatchObject({ success: true, data: { ui: null } });
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("passes no UI context to routes other than admin", async () => {
		const { db, runtime } = await buildRuntime();
		try {
			const result = await runtime.handlePluginApiRoute(
				"trusted-block-kit",
				"POST",
				"/inspect",
				new Request("https://example.test/_emdash/api/plugins/trusted-block-kit/inspect", {
					method: "POST",
					headers: { Cookie: "emdash-locale=ar" },
					body: JSON.stringify({ page: "/overview" }),
				}),
			);

			expect(result).toMatchObject({ success: true, data: { ui: null } });
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
