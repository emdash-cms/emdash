/**
 * Pipeline Rebuild Tests
 *
 * Verifies that rebuilding the HookPipeline after plugin enable/disable
 * correctly includes/excludes hooks from the affected plugins.
 *
 * This tests the fix for #105: disabled plugins' hooks kept firing because
 * the pipeline was constructed once at startup and never rebuilt.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createHookPipeline, resolveExclusiveHooks } from "../../../src/plugins/hooks.js";
import type { ResolvedPlugin, ResolvedHook, ContentHookEvent } from "../../../src/plugins/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: {
			pages: [],
			widgets: [],
		},
		hooks: {},
		routes: {},
		...overrides,
	};
}

function createTestHook<T>(
	pluginId: string,
	handler: T,
	overrides: Partial<ResolvedHook<T>> = {},
): ResolvedHook<T> {
	return {
		pluginId,
		handler,
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "continue",
		exclusive: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HookPipeline rebuild on plugin disable/enable (#105)", () => {
	let sqlite: InstanceType<typeof Database>;
	let db: Kysely<Record<string, unknown>>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		db = new Kysely<Record<string, unknown>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqlite.close();
	});

	it("hooks from disabled plugin do not fire after pipeline rebuild", async () => {
		const handlerA = vi.fn(async (event: ContentHookEvent) => ({
			...event.content,
			pluginA: true,
		}));
		const handlerB = vi.fn(async (event: ContentHookEvent) => ({
			...event.content,
			pluginB: true,
		}));

		const pluginA = createTestPlugin({
			id: "plugin-a",
			capabilities: ["write:content"],
			hooks: {
				"content:beforeSave": createTestHook("plugin-a", handlerA),
			},
		});

		const pluginB = createTestPlugin({
			id: "plugin-b",
			capabilities: ["write:content"],
			hooks: {
				"content:beforeSave": createTestHook("plugin-b", handlerB),
			},
		});

		const allPlugins = [pluginA, pluginB];

		// Initial pipeline with both plugins enabled
		const pipeline1 = createHookPipeline(allPlugins, { db });
		expect(pipeline1.hasHooks("content:beforeSave")).toBe(true);
		expect(pipeline1.getHookCount("content:beforeSave")).toBe(2);

		// Run hooks — both should fire
		const result1 = await pipeline1.runContentBeforeSave({ title: "test" }, "posts", true);
		expect(handlerA).toHaveBeenCalledTimes(1);
		expect(handlerB).toHaveBeenCalledTimes(1);
		expect(result1.content).toEqual({ title: "test", pluginA: true, pluginB: true });

		handlerA.mockClear();
		handlerB.mockClear();

		// Simulate disabling plugin-b: rebuild pipeline with only plugin-a
		const enabledPlugins = allPlugins.filter((p) => p.id !== "plugin-b");
		const pipeline2 = createHookPipeline(enabledPlugins, { db });
		expect(pipeline2.hasHooks("content:beforeSave")).toBe(true);
		expect(pipeline2.getHookCount("content:beforeSave")).toBe(1);

		// Run hooks — only plugin-a should fire
		const result2 = await pipeline2.runContentBeforeSave({ title: "test" }, "posts", true);
		expect(handlerA).toHaveBeenCalledTimes(1);
		expect(handlerB).not.toHaveBeenCalled();
		expect(result2.content).toEqual({ title: "test", pluginA: true });
	});

	it("hooks from re-enabled plugin fire after pipeline rebuild", async () => {
		const handlerA = vi.fn(async (event: ContentHookEvent) => ({
			...event.content,
			pluginA: true,
		}));
		const handlerB = vi.fn(async (event: ContentHookEvent) => ({
			...event.content,
			pluginB: true,
		}));

		const pluginA = createTestPlugin({
			id: "plugin-a",
			capabilities: ["write:content"],
			hooks: {
				"content:beforeSave": createTestHook("plugin-a", handlerA),
			},
		});

		const pluginB = createTestPlugin({
			id: "plugin-b",
			capabilities: ["write:content"],
			hooks: {
				"content:beforeSave": createTestHook("plugin-b", handlerB),
			},
		});

		const allPlugins = [pluginA, pluginB];

		// Start with only plugin-a (plugin-b is disabled)
		const pipeline1 = createHookPipeline([pluginA], { db });
		const result1 = await pipeline1.runContentBeforeSave({ title: "test" }, "posts", true);
		expect(handlerA).toHaveBeenCalledTimes(1);
		expect(handlerB).not.toHaveBeenCalled();
		expect(result1.content).toEqual({ title: "test", pluginA: true });

		handlerA.mockClear();

		// Re-enable plugin-b: rebuild pipeline with both
		const pipeline2 = createHookPipeline(allPlugins, { db });
		const result2 = await pipeline2.runContentBeforeSave({ title: "test" }, "posts", true);
		expect(handlerA).toHaveBeenCalledTimes(1);
		expect(handlerB).toHaveBeenCalledTimes(1);
		expect(result2.content).toEqual({ title: "test", pluginA: true, pluginB: true });
	});

	it("exclusive hook selections are re-resolved after rebuild", async () => {
		const handlerA = vi.fn().mockResolvedValue(undefined);
		const handlerB = vi.fn().mockResolvedValue(undefined);

		const pluginA = createTestPlugin({
			id: "provider-a",
			capabilities: ["email:provide"],
			hooks: {
				"email:deliver": createTestHook("provider-a", handlerA, { exclusive: true }),
			},
		});

		const pluginB = createTestPlugin({
			id: "provider-b",
			capabilities: ["email:provide"],
			hooks: {
				"email:deliver": createTestHook("provider-b", handlerB, { exclusive: true }),
			},
		});

		// Both enabled — two providers, no auto-select
		const pipeline1 = createHookPipeline([pluginA, pluginB], { db });
		expect(pipeline1.getExclusiveHookProviders("email:deliver")).toHaveLength(2);

		// Manually select provider-b (simulating admin selection)
		pipeline1.setExclusiveSelection("email:deliver", "provider-b");
		expect(pipeline1.getExclusiveSelection("email:deliver")).toBe("provider-b");

		// Disable provider-b: rebuild with only provider-a
		const pipeline2 = createHookPipeline([pluginA], { db });
		expect(pipeline2.getExclusiveHookProviders("email:deliver")).toHaveLength(1);

		// Run exclusive hook resolution — should auto-select the sole provider
		const options = new Map<string, string>();
		await resolveExclusiveHooks({
			pipeline: pipeline2,
			isActive: () => true,
			getOption: async (key) => options.get(key) ?? null,
			setOption: async (key, value) => {
				options.set(key, value);
			},
			deleteOption: async (key) => {
				options.delete(key);
			},
		});

		expect(pipeline2.getExclusiveSelection("email:deliver")).toBe("provider-a");
	});

	it("disabling all plugins with a hook removes that hook entirely", async () => {
		const handler = vi.fn(async () => undefined);

		const plugin = createTestPlugin({
			id: "only-plugin",
			capabilities: ["write:content"],
			hooks: {
				"content:beforeSave": createTestHook("only-plugin", handler),
			},
		});

		// Pipeline with the plugin
		const pipeline1 = createHookPipeline([plugin], { db });
		expect(pipeline1.hasHooks("content:beforeSave")).toBe(true);

		// Disable it: rebuild with empty list
		const pipeline2 = createHookPipeline([], { db });
		expect(pipeline2.hasHooks("content:beforeSave")).toBe(false);
		expect(pipeline2.getHookCount("content:beforeSave")).toBe(0);
	});

	it("lifecycle hooks for disabled plugin are excluded from pipeline", async () => {
		const installHandler = vi.fn();
		const activateHandler = vi.fn();

		const plugin = createTestPlugin({
			id: "lifecycle-plugin",
			hooks: {
				"plugin:install": createTestHook("lifecycle-plugin", installHandler),
				"plugin:activate": createTestHook("lifecycle-plugin", activateHandler),
			},
		});

		// Pipeline with plugin
		const pipeline1 = createHookPipeline([plugin], { db });
		expect(pipeline1.hasHooks("plugin:install")).toBe(true);
		expect(pipeline1.hasHooks("plugin:activate")).toBe(true);

		// Pipeline without plugin (disabled)
		const pipeline2 = createHookPipeline([], { db });
		expect(pipeline2.hasHooks("plugin:install")).toBe(false);
		expect(pipeline2.hasHooks("plugin:activate")).toBe(false);
	});

	it("plugin:activate fires when runPluginActivate is called after pipeline rebuild", async () => {
		const activateHandler = vi.fn().mockResolvedValue(undefined);

		const plugin = createTestPlugin({
			id: "my-plugin",
			hooks: {
				"plugin:activate": createTestHook("my-plugin", activateHandler),
			},
		});

		// Simulate enabling: rebuild pipeline with plugin included, then invoke activate
		const pipeline = createHookPipeline([plugin], { db });
		await pipeline.runPluginActivate("my-plugin");

		expect(activateHandler).toHaveBeenCalledTimes(1);
	});

	it("plugin:deactivate fires when runPluginDeactivate is called before pipeline rebuild", async () => {
		const deactivateHandler = vi.fn().mockResolvedValue(undefined);

		const plugin = createTestPlugin({
			id: "my-plugin",
			hooks: {
				"plugin:deactivate": createTestHook("my-plugin", deactivateHandler),
			},
		});

		// Simulate disabling: invoke deactivate on the current pipeline, then rebuild without the plugin
		const pipeline = createHookPipeline([plugin], { db });
		await pipeline.runPluginDeactivate("my-plugin");

		expect(deactivateHandler).toHaveBeenCalledTimes(1);

		// Rebuild without the plugin — hook should no longer be registered
		const disabledPipeline = createHookPipeline([], { db });
		expect(disabledPipeline.hasHooks("plugin:deactivate")).toBe(false);
	});

	it("plugin:activate only fires for the targeted plugin, not others", async () => {
		const activateA = vi.fn().mockResolvedValue(undefined);
		const activateB = vi.fn().mockResolvedValue(undefined);

		const pluginA = createTestPlugin({
			id: "plugin-a",
			hooks: {
				"plugin:activate": createTestHook("plugin-a", activateA),
			},
		});
		const pluginB = createTestPlugin({
			id: "plugin-b",
			hooks: {
				"plugin:activate": createTestHook("plugin-b", activateB),
			},
		});

		const pipeline = createHookPipeline([pluginA, pluginB], { db });

		// Enabling only plugin-a should not fire plugin-b's activate
		await pipeline.runPluginActivate("plugin-a");

		expect(activateA).toHaveBeenCalledTimes(1);
		expect(activateB).not.toHaveBeenCalled();
	});
});
