import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import type { Database } from "../../../src/database/types.js";
import {
	EmDashRuntime,
	__resetSandboxStateForTests,
	type SandboxedPluginEntry,
} from "../../../src/emdash-runtime.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { SandboxedPluginInstance, SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/** A fake loaded plugin instance with a spy on invokeHook. */
function fakeInstance(key: string): SandboxedPluginInstance {
	return {
		id: key,
		invokeHook: vi.fn(() => Promise.resolve(undefined)),
		invokeRoute: vi.fn(() => Promise.resolve(undefined)),
		terminate: vi.fn(() => Promise.resolve()),
	};
}

/** A fake sandbox runner whose `load` is a spy returning fake instances. */
function fakeRunner(): SandboxRunner & { load: ReturnType<typeof vi.fn> } {
	const load = vi.fn((manifest: { id: string; version: string }) =>
		Promise.resolve(fakeInstance(`${manifest.id}:${manifest.version}`)),
	);
	return {
		isAvailable: () => true,
		isHealthy: () => true,
		load,
		setEmailSend: () => {},
		terminateAll: () => Promise.resolve(),
	} as unknown as SandboxRunner & { load: ReturnType<typeof vi.fn> };
}

function buildEntry(overrides: Partial<SandboxedPluginEntry>): SandboxedPluginEntry {
	return {
		id: "wh",
		version: "1.0.0",
		options: {},
		code: "export default {};",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		...overrides,
	};
}

function buildRuntime(
	db: Kysely<Database>,
	entries: SandboxedPluginEntry[],
	runner: SandboxRunner,
): EmDashRuntime {
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([], pipelineFactoryOptions);
	const runtimeDeps = {
		config,
		plugins: [],
		// eslint-disable-next-line typescript/no-explicit-any -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: entries,
		createSandboxRunner: () => runner,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: entries,
		hooks,
		enabledPlugins: new Set(entries.map((e) => e.id)),
		// Empty states map → isPluginEnabled treats every plugin as enabled
		// (status undefined). Individual tests override to "disabled" as needed.
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [],
		pipelineFactoryOptions,
		// eslint-disable-next-line typescript/no-explicit-any -- partial deps sufficient for these tests
		runtimeDeps: runtimeDeps as any,
		pipelineRef: { current: hooks },
	});
}

const PAGE = {
	url: new URL("https://example.com/posts/hello"),
	pathname: "/posts/hello",
	collection: "posts",
	// eslint-disable-next-line typescript/no-explicit-any -- minimal page context for the metadata collector
} as any;

describe("sandboxed plugin lazy loading", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		__resetSandboxStateForTests();
	});

	afterEach(async () => {
		__resetSandboxStateForTests();
		await teardownTestDatabase(db);
	});

	it("does not load a write-only plugin on a public render (read path)", async () => {
		const runner = fakeRunner();
		// Declares only content:afterSave — nothing a public render exercises.
		const runtime = buildRuntime(
			db,
			[buildEntry({ hooks: ["content:afterSave"], routes: [] })],
			runner,
		);

		await runtime.collectPageContributions(PAGE);

		expect(runner.load).not.toHaveBeenCalled();
	});

	it("loads a plugin that declares page:metadata on render, and invokes it", async () => {
		const runner = fakeRunner();
		const runtime = buildRuntime(
			db,
			[buildEntry({ hooks: ["page:metadata"], routes: [] })],
			runner,
		);

		await runtime.collectPageContributions(PAGE);

		expect(runner.load).toHaveBeenCalledTimes(1);
		const instance = await runner.load.mock.results[0]!.value;
		expect(instance.invokeHook).toHaveBeenCalledWith("page:metadata", { page: PAGE });
	});

	it("loads a plugin with unknown (undefined) declared hooks, to stay correct", async () => {
		const runner = fakeRunner();
		// hooks omitted → "unknown" (e.g. built before manifests carried hooks).
		const runtime = buildRuntime(db, [buildEntry({ routes: [] })], runner);

		await runtime.collectPageContributions(PAGE);

		expect(runner.load).toHaveBeenCalledTimes(1);
	});

	it("ensureSandboxedPluginLoaded loads once and dedupes concurrent calls", async () => {
		const runner = fakeRunner();
		const runtime = buildRuntime(db, [buildEntry({ hooks: ["content:afterSave"] })], runner);

		const [a, b] = await Promise.all([
			runtime.ensureSandboxedPluginLoaded("wh"),
			runtime.ensureSandboxedPluginLoaded("wh"),
		]);

		expect(runner.load).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);

		// A subsequent call returns the memoized instance without reloading.
		const c = await runtime.ensureSandboxedPluginLoaded("wh");
		expect(runner.load).toHaveBeenCalledTimes(1);
		expect(c).toBe(a);
	});

	it("returns null and does not load when the plugin is disabled", async () => {
		const runner = fakeRunner();
		const runtime = buildRuntime(db, [buildEntry({ hooks: ["content:afterSave"] })], runner);
		// Disable it.
		// eslint-disable-next-line typescript/no-explicit-any -- reach into private state for the test
		(runtime as any).pluginStates.set("wh", "disabled");

		const result = await runtime.ensureSandboxedPluginLoaded("wh");
		expect(result).toBeNull();
		expect(runner.load).not.toHaveBeenCalled();
	});
});
