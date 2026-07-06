/**
 * Statically-sandboxed plugins through the real admin plugin routes and a real
 * EmDashRuntime: the list route surfaces them, and the enable/disable routes
 * toggle them without error.
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { POST as disablePlugin } from "../../../src/astro/routes/api/admin/plugins/[id]/disable.js";
import { POST as enablePlugin } from "../../../src/astro/routes/api/admin/plugins/[id]/enable.js";
import { GET as listPlugins } from "../../../src/astro/routes/api/admin/plugins/index.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime, type SandboxedPluginEntry } from "../../../src/emdash-runtime.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildRuntime(db: Kysely<Database>, entries: SandboxedPluginEntry[]): EmDashRuntime {
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([], pipelineFactoryOptions);
	const pipelineRef = { current: hooks };
	const runtimeDeps = {
		config,
		plugins: [],
		// eslint-disable-next-line typescript/no-explicit-any -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: entries,
		createSandboxRunner: null,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: entries,
		hooks,
		enabledPlugins: new Set(),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef,
	});
}

// Role.ADMIN is 50 in @emdash-cms/auth; plugins:read / plugins:manage require it.
const admin = { id: "admin-1", role: 50 };

// Mirror the subset of the middleware's `locals.emdash` facade that the plugin
// routes read. The facade once dropped `sandboxedPluginEntries` (not compile-checked
// here), which a raw-runtime fixture would hide, so this drives the real field through.
function facade(runtime: EmDashRuntime) {
	return {
		db: runtime.db,
		configuredPlugins: runtime.configuredPlugins,
		sandboxedPluginEntries: runtime.sandboxedPluginEntries,
		config: runtime.config,
		setPluginStatus: runtime.setPluginStatus.bind(runtime),
	};
}

function ctx(runtime: EmDashRuntime, params: Record<string, string> = {}): APIContext {
	return {
		locals: { emdash: facade(runtime), user: admin },
		params,
		request: new Request("http://test.local/_emdash/api/admin/plugins"),
	} as unknown as APIContext;
}

function sandboxedEntry(overrides: Partial<SandboxedPluginEntry> = {}): SandboxedPluginEntry {
	return {
		id: "webhook-notifier",
		version: "0.1.0",
		options: {},
		code: "",
		capabilities: ["network:fetch"],
		allowedHosts: ["*"],
		storage: {},
		adminPages: [],
		adminWidgets: [],
		...overrides,
	};
}

async function listIds(runtime: EmDashRuntime) {
	const res = await listPlugins(ctx(runtime));
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		data: { items: Array<{ id: string; source?: string; sandboxed?: boolean; enabled: boolean }> };
	};
	return body.data;
}

describe("admin plugin routes: statically-sandboxed plugins (real runtime)", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();
		runtime = buildRuntime(db, [sandboxedEntry()]);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("the list route surfaces a sandboxed plugin from the runtime", async () => {
		const body = await listIds(runtime);
		const plugin = body.items.find((p) => p.id === "webhook-notifier");
		expect(plugin).toMatchObject({ source: "config", sandboxed: true, enabled: true });
	});

	it("the enable and disable routes toggle a sandboxed plugin end to end", async () => {
		const off = await disablePlugin(ctx(runtime, { id: "webhook-notifier" }));
		expect(off.status).toBe(200);
		let body = await listIds(runtime);
		expect(body.items.find((p) => p.id === "webhook-notifier")?.enabled).toBe(false);

		const on = await enablePlugin(ctx(runtime, { id: "webhook-notifier" }));
		expect(on.status).toBe(200);
		body = await listIds(runtime);
		expect(body.items.find((p) => p.id === "webhook-notifier")?.enabled).toBe(true);
	});
});
