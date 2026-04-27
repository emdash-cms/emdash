/**
 * Exclusive Hooks Tests
 *
 * Tests the exclusive hook system:
 * - HookPipeline: registration/tracking, selection, invokeExclusiveHook
 * - PluginManager.resolveExclusiveHooks(): single provider auto-select,
 *   multi-provider no auto-select, stale selection clearing, preferred hints,
 *   admin override beats preferred
 * - Lifecycle: activate → auto-select, deactivate → clears stale selection
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { extractManifest } from "../../../src/cli/commands/bundle-utils.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { HookPipeline, resolveExclusiveHooks } from "../../../src/plugins/hooks.js";
import { PluginManager } from "../../../src/plugins/manager.js";
import { normalizeManifestHook } from "../../../src/plugins/manifest-schema.js";
import type {
	ResolvedPlugin,
	ResolvedHook,
	PluginDefinition,
	ContentBeforeSaveHandler,
	ContentAfterSaveHandler,
} from "../../../src/plugins/types.js";

// ---------------------------------------------------------------------------
// Helpers — ResolvedPlugin (for HookPipeline tests)
// ---------------------------------------------------------------------------

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: ["write:content", "read:content"],
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
// Helpers — PluginDefinition (for PluginManager tests)
// ---------------------------------------------------------------------------

function createTestDefinition(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: ["write:content", "read:content"],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// HookPipeline — exclusive behaviour
// ---------------------------------------------------------------------------

describe("HookPipeline — exclusive hooks", () => {
	it("tracks exclusive hook names during registration", () => {
		const plugin = createTestPlugin({
			id: "email-provider",
			hooks: {
				"content:beforeSave": createTestHook("email-provider", vi.fn(), {
					exclusive: true,
				}),
			},
		});

		const pipeline = new HookPipeline([plugin]);

		expect(pipeline.isExclusiveHook("content:beforeSave")).toBe(true);
		expect(pipeline.isExclusiveHook("content:afterSave")).toBe(false);
		expect(pipeline.getRegisteredExclusiveHooks()).toContain("content:beforeSave");
	});

	it("does not track non-exclusive hooks as exclusive", () => {
		const plugin = createTestPlugin({
			id: "normal-plugin",
			hooks: {
				"content:beforeSave": createTestHook("normal-plugin", vi.fn(), {
					exclusive: false,
				}),
			},
		});

		const pipeline = new HookPipeline([plugin]);

		expect(pipeline.isExclusiveHook("content:beforeSave")).toBe(false);
		expect(pipeline.getRegisteredExclusiveHooks()).not.toContain("content:beforeSave");
	});

	it("returns providers for an exclusive hook", () => {
		const plugin1 = createTestPlugin({
			id: "provider-a",
			hooks: {
				"content:beforeSave": createTestHook("provider-a", vi.fn(), { exclusive: true }),
			},
		});
		const plugin2 = createTestPlugin({
			id: "provider-b",
			hooks: {
				"content:beforeSave": createTestHook("provider-b", vi.fn(), { exclusive: true }),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2]);

		const providers = pipeline.getExclusiveHookProviders("content:beforeSave");
		expect(providers).toHaveLength(2);
		expect(providers.map((p) => p.pluginId)).toEqual(
			expect.arrayContaining(["provider-a", "provider-b"]),
		);
	});

	it("set/get/clear exclusive selection", () => {
		const plugin = createTestPlugin({
			id: "email-ses",
			hooks: {
				"content:beforeSave": createTestHook("email-ses", vi.fn(), { exclusive: true }),
			},
		});

		const pipeline = new HookPipeline([plugin]);

		expect(pipeline.getExclusiveSelection("content:beforeSave")).toBeUndefined();

		pipeline.setExclusiveSelection("content:beforeSave", "email-ses");
		expect(pipeline.getExclusiveSelection("content:beforeSave")).toBe("email-ses");

		pipeline.clearExclusiveSelection("content:beforeSave");
		expect(pipeline.getExclusiveSelection("content:beforeSave")).toBeUndefined();
	});

	it("invokeExclusiveHook returns null when no selection", async () => {
		const handler = vi.fn().mockResolvedValue("result");
		const plugin = createTestPlugin({
			id: "provider-a",
			hooks: {
				"content:beforeSave": createTestHook("provider-a", handler, { exclusive: true }),
			},
		});

		const pipeline = new HookPipeline([plugin]);

		const result = await pipeline.invokeExclusiveHook("content:beforeSave", { some: "event" });
		expect(result).toBeNull();
		expect(handler).not.toHaveBeenCalled();
	});

	it("invokeExclusiveHook dispatches only to selected provider", async () => {
		const handlerA = vi.fn().mockResolvedValue("result-a");
		const handlerB = vi.fn().mockResolvedValue("result-b");

		const pluginA = createTestPlugin({
			id: "provider-a",
			hooks: {
				"content:afterSave": createTestHook("provider-a", handlerA, { exclusive: true }),
			},
		});
		const pluginB = createTestPlugin({
			id: "provider-b",
			hooks: {
				"content:afterSave": createTestHook("provider-b", handlerB, { exclusive: true }),
			},
		});

		// Context factory needs a db for PluginContextFactory
		const sqlite = new Database(":memory:");
		const db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		const pipeline = new HookPipeline([pluginA, pluginB], { db });

		pipeline.setExclusiveSelection("content:afterSave", "provider-b");

		const result = await pipeline.invokeExclusiveHook("content:afterSave", { some: "event" });

		expect(result).not.toBeNull();
		expect(result!.pluginId).toBe("provider-b");
		expect(result!.result).toBe("result-b");

		expect(handlerB).toHaveBeenCalledTimes(1);
		expect(handlerA).not.toHaveBeenCalled();

		await db.destroy();
		sqlite.close();
	});

	it("invokeExclusiveHook isolates errors — returns error result instead of throwing", async () => {
		const handler = vi
			.fn()
			.mockRejectedValue(new Error("provider crashed")) as unknown as ContentAfterSaveHandler;

		const plugin = createTestPlugin({
			id: "broken-provider",
			hooks: {
				"content:afterSave": createTestHook("broken-provider", handler, {
					exclusive: true,
				}),
			},
		});

		const sqlite = new Database(":memory:");
		const db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		const pipeline = new HookPipeline([plugin], { db });
		pipeline.setExclusiveSelection("content:afterSave", "broken-provider");

		// Should NOT throw — error is isolated
		const result = await pipeline.invokeExclusiveHook("content:afterSave", {});

		expect(result).not.toBeNull();
		expect(result!.pluginId).toBe("broken-provider");
		expect(result!.error).toBeInstanceOf(Error);
		expect(result!.error!.message).toBe("provider crashed");
		expect(result!.result).toBeUndefined();
		expect(result!.duration).toBeGreaterThanOrEqual(0);

		await db.destroy();
		sqlite.close();
	});

	it("invokeExclusiveHook respects timeout", async () => {
		const handler = vi.fn(
			() =>
				new Promise((resolve) => {
					setTimeout(resolve, 10_000);
				}),
		) as unknown as ContentAfterSaveHandler;

		const plugin = createTestPlugin({
			id: "slow-provider",
			hooks: {
				"content:afterSave": createTestHook("slow-provider", handler, {
					exclusive: true,
					timeout: 50,
				}),
			},
		});

		const sqlite = new Database(":memory:");
		const db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		const pipeline = new HookPipeline([plugin], { db });
		pipeline.setExclusiveSelection("content:afterSave", "slow-provider");

		const result = await pipeline.invokeExclusiveHook("content:afterSave", {});

		expect(result).not.toBeNull();
		expect(result!.error).toBeInstanceOf(Error);
		expect(result!.error!.message.toLowerCase()).toContain("timeout");

		await db.destroy();
		sqlite.close();
	});

	it("exclusive hooks with a selection are skipped in regular pipeline", async () => {
		const exclusiveHandler = vi.fn().mockResolvedValue(undefined);
		const normalHandler = vi.fn().mockResolvedValue(undefined);

		const exclusivePlugin = createTestPlugin({
			id: "exclusive-plugin",
			hooks: {
				"content:afterSave": createTestHook("exclusive-plugin", exclusiveHandler, {
					exclusive: true,
				}),
			},
		});
		const normalPlugin = createTestPlugin({
			id: "normal-plugin",
			hooks: {
				"content:afterSave": createTestHook("normal-plugin", normalHandler, {
					exclusive: false,
				}),
			},
		});

		const sqlite = new Database(":memory:");
		const db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		const pipeline = new HookPipeline([exclusivePlugin, normalPlugin], { db });

		// Set a selection — this means the exclusive hook should NOT run in the regular pipeline
		pipeline.setExclusiveSelection("content:afterSave", "exclusive-plugin");

		await pipeline.runContentAfterSave({ title: "test" }, "posts", true);

		// Normal hook should run
		expect(normalHandler).toHaveBeenCalledTimes(1);
		// Exclusive hook should NOT have run in the regular pipeline
		expect(exclusiveHandler).not.toHaveBeenCalled();

		await db.destroy();
		sqlite.close();
	});

	it("exclusive hooks without a selection DO run in regular pipeline", async () => {
		const exclusiveHandler = vi.fn().mockResolvedValue(undefined);

		const plugin = createTestPlugin({
			id: "unselected-provider",
			hooks: {
				"content:afterSave": createTestHook("unselected-provider", exclusiveHandler, {
					exclusive: true,
				}),
			},
		});

		const sqlite = new Database(":memory:");
		const db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		const pipeline = new HookPipeline([plugin], { db });

		// No selection set — exclusive hooks should still run in regular pipeline
		await pipeline.runContentAfterSave({ title: "test" }, "posts", true);

		expect(exclusiveHandler).toHaveBeenCalledTimes(1);

		await db.destroy();
		sqlite.close();
	});
});

// ---------------------------------------------------------------------------
// HookPipeline — non-exclusive provider enumeration
// ---------------------------------------------------------------------------

describe("HookPipeline — getHookProviders", () => {
	it("returns non-exclusive providers registered for a hook", () => {
		const plugin1 = createTestPlugin({
			id: "middleware-a",
			capabilities: ["email:intercept"],
			hooks: {
				"email:beforeSend": createTestHook("middleware-a", vi.fn()),
			},
		});
		const plugin2 = createTestPlugin({
			id: "middleware-b",
			capabilities: ["email:intercept"],
			hooks: {
				"email:beforeSend": createTestHook("middleware-b", vi.fn()),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2]);

		const providers = pipeline.getHookProviders("email:beforeSend");
		expect(providers.map((p) => p.pluginId)).toEqual(
			expect.arrayContaining(["middleware-a", "middleware-b"]),
		);
		expect(providers).toHaveLength(2);
	});

	it("partitions with getExclusiveHookProviders — excludes exclusive registrations", () => {
		const exclusivePlugin = createTestPlugin({
			id: "exclusive-provider",
			hooks: {
				"content:beforeSave": createTestHook("exclusive-provider", vi.fn(), { exclusive: true }),
			},
		});
		const nonExclusivePlugin = createTestPlugin({
			id: "non-exclusive-provider",
			hooks: {
				"content:beforeSave": createTestHook("non-exclusive-provider", vi.fn()),
			},
		});

		const pipeline = new HookPipeline([exclusivePlugin, nonExclusivePlugin]);

		expect(pipeline.getHookProviders("content:beforeSave").map((p) => p.pluginId)).toEqual([
			"non-exclusive-provider",
		]);
		expect(pipeline.getExclusiveHookProviders("content:beforeSave").map((p) => p.pluginId)).toEqual(
			["exclusive-provider"],
		);
	});

	it("returns empty array for an unregistered hook", () => {
		const pipeline = new HookPipeline([]);
		expect(pipeline.getHookProviders("email:beforeSend")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// normalizeManifestHook
// ---------------------------------------------------------------------------

describe("normalizeManifestHook", () => {
	it("converts a plain string to an object", () => {
		const result = normalizeManifestHook("content:beforeSave");
		expect(result).toEqual({ name: "content:beforeSave" });
	});

	it("passes through an object unchanged", () => {
		const entry = { name: "content:beforeSave", exclusive: true, priority: 50 };
		const result = normalizeManifestHook(entry);
		expect(result).toEqual(entry);
	});

	it("handles object with only name", () => {
		const result = normalizeManifestHook({ name: "media:afterUpload" });
		expect(result).toEqual({ name: "media:afterUpload" });
	});
});

// ---------------------------------------------------------------------------
// extractManifest — exclusive hook metadata
// ---------------------------------------------------------------------------

describe("extractManifest — exclusive hooks", () => {
	it("emits plain hook names for non-exclusive hooks with default settings", () => {
		const plugin = createTestPlugin({
			id: "simple-plugin",
			hooks: {
				"content:beforeSave": createTestHook("simple-plugin", vi.fn()),
			},
		});

		const manifest = extractManifest(plugin);
		expect(manifest.hooks).toEqual(["content:beforeSave"]);
	});

	it("emits structured entries for exclusive hooks", () => {
		const plugin = createTestPlugin({
			id: "email-provider",
			hooks: {
				"content:beforeSave": createTestHook("email-provider", vi.fn(), {
					exclusive: true,
				}),
			},
		});

		const manifest = extractManifest(plugin);
		expect(manifest.hooks).toEqual([{ name: "content:beforeSave", exclusive: true }]);
	});

	it("emits structured entries for hooks with custom priority or timeout", () => {
		const plugin = createTestPlugin({
			id: "custom-plugin",
			hooks: {
				"content:afterSave": createTestHook("custom-plugin", vi.fn(), {
					priority: 50,
					timeout: 10000,
				}),
			},
		});

		const manifest = extractManifest(plugin);
		expect(manifest.hooks).toEqual([{ name: "content:afterSave", priority: 50, timeout: 10000 }]);
	});

	it("handles mixed exclusive and non-exclusive hooks", () => {
		const plugin = createTestPlugin({
			id: "mixed-plugin",
			hooks: {
				"content:beforeSave": createTestHook("mixed-plugin", vi.fn(), { exclusive: true }),
				"content:afterSave": createTestHook("mixed-plugin", vi.fn()),
			},
		});

		const manifest = extractManifest(plugin);
		expect(manifest.hooks).toHaveLength(2);

		// One should be structured (exclusive), one should be a plain string
		const structured = manifest.hooks.filter((h) => typeof h === "object");
		const plain = manifest.hooks.filter((h) => typeof h === "string");
		expect(structured).toHaveLength(1);
		expect(plain).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// resolveExclusiveHooks (shared function)
// ---------------------------------------------------------------------------

describe("resolveExclusiveHooks — shared function", () => {
	it("auto-selects single active provider", async () => {
		const plugin = createTestPlugin({
			id: "only-provider",
			hooks: {
				"content:beforeSave": createTestHook("only-provider", vi.fn(), { exclusive: true }),
			},
		});
		const pipeline = new HookPipeline([plugin]);

		const store = new Map<string, string>();

		await resolveExclusiveHooks({
			pipeline,
			isActive: () => true,
			getOption: async (key) => store.get(key) ?? null,
			setOption: async (key, value) => {
				store.set(key, value);
			},
			deleteOption: async (key) => {
				store.delete(key);
			},
		});

		expect(pipeline.getExclusiveSelection("content:beforeSave")).toBe("only-provider");
	});

	it("filters out inactive providers", async () => {
		const pluginA = createTestPlugin({
			id: "active-provider",
			hooks: {
				"content:beforeSave": createTestHook("active-provider", vi.fn(), { exclusive: true }),
			},
		});
		const pluginB = createTestPlugin({
			id: "inactive-provider",
			hooks: {
				"content:beforeSave": createTestHook("inactive-provider", vi.fn(), { exclusive: true }),
			},
		});
		const pipeline = new HookPipeline([pluginA, pluginB]);

		const store = new Map<string, string>();

		await resolveExclusiveHooks({
			pipeline,
			isActive: (id) => id === "active-provider",
			getOption: async (key) => store.get(key) ?? null,
			setOption: async (key, value) => {
				store.set(key, value);
			},
			deleteOption: async (key) => {
				store.delete(key);
			},
		});

		// Only active-provider is active, so it should be auto-selected
		expect(pipeline.getExclusiveSelection("content:beforeSave")).toBe("active-provider");
	});

	it("clears stale selection when selected provider is inactive", async () => {
		const pluginA = createTestPlugin({
			id: "provider-a",
			hooks: {
				"content:beforeSave": createTestHook("provider-a", vi.fn(), { exclusive: true }),
			},
		});
		const pluginB = createTestPlugin({
			id: "provider-b",
			hooks: {
				"content:beforeSave": createTestHook("provider-b", vi.fn(), { exclusive: true }),
			},
		});
		const pipeline = new HookPipeline([pluginA, pluginB]);

		// Simulate existing selection for provider-a which is now inactive
		const store = new Map<string, string>([
			["emdash:exclusive_hook:content:beforeSave", "provider-a"],
		]);

		await resolveExclusiveHooks({
			pipeline,
			isActive: (id) => id === "provider-b", // provider-a is inactive
			getOption: async (key) => store.get(key) ?? null,
			setOption: async (key, value) => {
				store.set(key, value);
			},
			deleteOption: async (key) => {
				store.delete(key);
			},
		});

		// provider-a was stale, cleared. provider-b is the only active one → auto-selected
		expect(pipeline.getExclusiveSelection("content:beforeSave")).toBe("provider-b");
	});
});

// ---------------------------------------------------------------------------
// PluginManager — resolveExclusiveHooks
// ---------------------------------------------------------------------------

describe("PluginManager — resolveExclusiveHooks", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(async () => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("auto-selects when only one provider for an exclusive hook", async () => {
		const handler = vi.fn() as unknown as ContentBeforeSaveHandler;

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "email-ses",
				hooks: {
					"content:beforeSave": { handler, exclusive: true },
				},
			}),
		);
		await manager.activate("email-ses");

		const selection = await manager.getExclusiveHookSelection("content:beforeSave");
		expect(selection).toBe("email-ses");
	});

	it("keeps auto-selected provider when a second provider activates", async () => {
		const handlerA = vi.fn() as unknown as ContentBeforeSaveHandler;
		const handlerB = vi.fn() as unknown as ContentBeforeSaveHandler;

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "provider-a",
				hooks: { "content:beforeSave": { handler: handlerA, exclusive: true } },
			}),
		);
		manager.register(
			createTestDefinition({
				id: "provider-b",
				hooks: { "content:beforeSave": { handler: handlerB, exclusive: true } },
			}),
		);

		// provider-a is the only one — gets auto-selected
		await manager.activate("provider-a");
		expect(await manager.getExclusiveHookSelection("content:beforeSave")).toBe("provider-a");

		// provider-b activates — existing valid selection is preserved
		await manager.activate("provider-b");
		expect(await manager.getExclusiveHookSelection("content:beforeSave")).toBe("provider-a");
	});

	it("leaves unselected when multiple providers activate simultaneously", async () => {
		// If no one was auto-selected before the second provider, there's no
		// selection to keep. Test this by registering both before activating.
		const handlerA = vi.fn() as unknown as ContentBeforeSaveHandler;
		const handlerB = vi.fn() as unknown as ContentBeforeSaveHandler;

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "provider-a",
				hooks: { "content:beforeSave": { handler: handlerA, exclusive: true } },
			}),
		);
		manager.register(
			createTestDefinition({
				id: "provider-b",
				hooks: { "content:beforeSave": { handler: handlerB, exclusive: true } },
			}),
		);

		// Activate provider-a (auto-selects as sole provider)
		await manager.activate("provider-a");
		// Clear the auto-selection to simulate "no prior selection"
		await manager.setExclusiveHookSelection("content:beforeSave", null);

		// Now activate provider-b — both active, no existing selection
		await manager.activate("provider-b");
		const selection = await manager.getExclusiveHookSelection("content:beforeSave");
		expect(selection).toBeNull();
	});

	it("clears stale selection when selected plugin is deactivated", async () => {
		const handlerA = vi.fn() as unknown as ContentBeforeSaveHandler;
		const handlerB = vi.fn() as unknown as ContentBeforeSaveHandler;

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "provider-a",
				hooks: { "content:beforeSave": { handler: handlerA, exclusive: true } },
			}),
		);
		manager.register(
			createTestDefinition({
				id: "provider-b",
				hooks: { "content:beforeSave": { handler: handlerB, exclusive: true } },
			}),
		);

		await manager.activate("provider-a");
		await manager.activate("provider-b");

		// Manually set a selection
		await manager.setExclusiveHookSelection("content:beforeSave", "provider-a");
		expect(await manager.getExclusiveHookSelection("content:beforeSave")).toBe("provider-a");

		// Deactivate the selected plugin
		await manager.deactivate("provider-a");

		// After deactivation, provider-b is the only one left → auto-selects
		const selection = await manager.getExclusiveHookSelection("content:beforeSave");
		expect(selection).toBe("provider-b");
	});

	it("uses preferred hints when no selection exists", async () => {
		const handlerA = vi.fn() as unknown as ContentBeforeSaveHandler;
		const handlerB = vi.fn() as unknown as ContentBeforeSaveHandler;

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "provider-a",
				hooks: { "content:beforeSave": { handler: handlerA, exclusive: true } },
			}),
		);
		manager.register(
			createTestDefinition({
				id: "provider-b",
				hooks: { "content:beforeSave": { handler: handlerB, exclusive: true } },
			}),
		);

		await manager.activate("provider-a");
		await manager.activate("provider-b");

		// Clear any auto-selection from the first activate
		await manager.setExclusiveHookSelection("content:beforeSave", null);
		expect(await manager.getExclusiveHookSelection("content:beforeSave")).toBeNull();

		// Resolve with preferred hint
		const hints = new Map([["provider-b", ["content:beforeSave"]]]);
		await manager.resolveExclusiveHooks(hints);

		expect(await manager.getExclusiveHookSelection("content:beforeSave")).toBe("provider-b");
	});

	it("admin override (DB selection) beats preferred hints", async () => {
		const handlerA = vi.fn() as unknown as ContentBeforeSaveHandler;
		const handlerB = vi.fn() as unknown as ContentBeforeSaveHandler;

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "provider-a",
				hooks: { "content:beforeSave": { handler: handlerA, exclusive: true } },
			}),
		);
		manager.register(
			createTestDefinition({
				id: "provider-b",
				hooks: { "content:beforeSave": { handler: handlerB, exclusive: true } },
			}),
		);

		await manager.activate("provider-a");
		await manager.activate("provider-b");

		// Admin explicitly sets provider-a
		await manager.setExclusiveHookSelection("content:beforeSave", "provider-a");

		// Resolve with preferred hint for provider-b — admin choice should win
		const hints = new Map([["provider-b", ["content:beforeSave"]]]);
		await manager.resolveExclusiveHooks(hints);

		expect(await manager.getExclusiveHookSelection("content:beforeSave")).toBe("provider-a");
	});

	it("getExclusiveHooksInfo returns complete info", async () => {
		const handler = vi.fn() as unknown as ContentBeforeSaveHandler;

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "provider-a",
				hooks: { "content:beforeSave": { handler, exclusive: true } },
			}),
		);
		await manager.activate("provider-a");

		const info = await manager.getExclusiveHooksInfo();
		expect(info).toHaveLength(1);
		expect(info[0]!.hookName).toBe("content:beforeSave");
		expect(info[0]!.providers).toHaveLength(1);
		expect(info[0]!.providers[0]!.pluginId).toBe("provider-a");
		expect(info[0]!.selectedPluginId).toBe("provider-a");
	});
});
