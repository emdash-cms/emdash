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
import type { KyselyPlugin } from "kysely";
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
	ContentBeforeDeleteHandler,
} from "../../../src/plugins/types.js";
import { describeEachDialect, setupForDialect, teardownForDialect } from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Helpers — ResolvedPlugin (for HookPipeline tests)
// ---------------------------------------------------------------------------

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: ["content:write", "content:read"],
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
		capabilities: ["content:write", "content:read"],
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
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("middleware-a", vi.fn()),
			},
		});
		const plugin2 = createTestPlugin({
			id: "middleware-b",
			capabilities: ["hooks.email-events:register"],
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

// ---------------------------------------------------------------------------
// resolveExclusiveHooks — batched option reads
// ---------------------------------------------------------------------------

describe("resolveExclusiveHooks — batched option reads", () => {
	/**
	 * Three plugins / three exclusive hooks covering every resolution branch:
	 * - content:beforeSave: providers a+b active, valid stored selection (kept)
	 * - content:afterSave: provider c stale (inactive), a remains (auto-select)
	 * - content:beforeDelete: providers a+b active, no selection (unselected)
	 */
	function createScenarioPipeline(): HookPipeline {
		const pluginA = createTestPlugin({
			id: "provider-a",
			hooks: {
				"content:beforeSave": createTestHook("provider-a", vi.fn(), { exclusive: true }),
				"content:afterSave": createTestHook("provider-a", vi.fn(), { exclusive: true }),
				"content:beforeDelete": createTestHook("provider-a", vi.fn(), { exclusive: true }),
			},
		});
		const pluginB = createTestPlugin({
			id: "provider-b",
			hooks: {
				"content:beforeSave": createTestHook("provider-b", vi.fn(), { exclusive: true }),
				"content:beforeDelete": createTestHook("provider-b", vi.fn(), { exclusive: true }),
			},
		});
		const pluginC = createTestPlugin({
			id: "provider-c",
			hooks: {
				"content:afterSave": createTestHook("provider-c", vi.fn(), { exclusive: true }),
			},
		});
		return new HookPipeline([pluginA, pluginB, pluginC]);
	}

	function createScenarioStore(): Map<string, string> {
		return new Map([
			["emdash:exclusive_hook:content:beforeSave", "provider-a"],
			["emdash:exclusive_hook:content:afterSave", "provider-c"],
		]);
	}

	function createStoreCallbacks(store: Map<string, string>) {
		return {
			getOption: vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
			getOptions: vi.fn(async (keys: string[]): Promise<ReadonlyMap<string, string>> => {
				const result = new Map<string, string>();
				for (const key of keys) {
					const value = store.get(key);
					if (value !== undefined) result.set(key, value);
				}
				return result;
			}),
			setOption: vi.fn(async (key: string, value: string) => {
				store.set(key, value);
			}),
			deleteOption: vi.fn(async (key: string) => {
				store.delete(key);
			}),
		};
	}

	const isActive = (id: string) => id !== "provider-c";

	it("reads all selections with one getOptions call and no per-hook gets", async () => {
		const pipeline = createScenarioPipeline();
		const store = createScenarioStore();
		const callbacks = createStoreCallbacks(store);

		await resolveExclusiveHooks({ pipeline, isActive, ...callbacks });

		expect(callbacks.getOptions).toHaveBeenCalledTimes(1);
		expect(callbacks.getOptions.mock.calls[0]![0]).toEqual(
			expect.arrayContaining([
				"emdash:exclusive_hook:content:beforeSave",
				"emdash:exclusive_hook:content:afterSave",
				"emdash:exclusive_hook:content:beforeDelete",
			]),
		);
		expect(callbacks.getOption).not.toHaveBeenCalled();
	});

	it("resolves identically to the per-key path", async () => {
		// Batched path
		const batchedPipeline = createScenarioPipeline();
		const batchedStore = createScenarioStore();
		await resolveExclusiveHooks({
			pipeline: batchedPipeline,
			isActive,
			...createStoreCallbacks(batchedStore),
		});

		// Per-key path (no getOptions)
		const perKeyPipeline = createScenarioPipeline();
		const perKeyStore = createScenarioStore();
		const { getOptions: _unused, ...perKeyCallbacks } = createStoreCallbacks(perKeyStore);
		await resolveExclusiveHooks({
			pipeline: perKeyPipeline,
			isActive,
			...perKeyCallbacks,
		});

		for (const hookName of ["content:beforeSave", "content:afterSave", "content:beforeDelete"]) {
			expect(batchedPipeline.getExclusiveSelection(hookName)).toBe(
				perKeyPipeline.getExclusiveSelection(hookName),
			);
		}
		expect(batchedStore).toEqual(perKeyStore);

		// Sanity-check the actual outcomes, not just parity
		expect(batchedPipeline.getExclusiveSelection("content:beforeSave")).toBe("provider-a");
		expect(batchedPipeline.getExclusiveSelection("content:afterSave")).toBe("provider-a");
		expect(batchedPipeline.getExclusiveSelection("content:beforeDelete")).toBeUndefined();
	});

	it("skips resolution when the batch read fails (options table not ready)", async () => {
		const pipeline = createScenarioPipeline();
		const callbacks = createStoreCallbacks(createScenarioStore());
		callbacks.getOptions.mockRejectedValue(new Error("no such table: options"));

		await expect(
			resolveExclusiveHooks({ pipeline, isActive, ...callbacks }),
		).resolves.toBeUndefined();

		// Matches the per-key tolerance: nothing written, nothing selected
		expect(callbacks.setOption).not.toHaveBeenCalled();
		expect(callbacks.deleteOption).not.toHaveBeenCalled();
		expect(pipeline.getExclusiveSelection("content:beforeSave")).toBeUndefined();
		expect(pipeline.getExclusiveSelection("content:afterSave")).toBeUndefined();
		expect(pipeline.getExclusiveSelection("content:beforeDelete")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// PluginManager — batched resolution against a real database
// ---------------------------------------------------------------------------

/**
 * Kysely plugin that counts compiled SELECT statements — one per executed
 * select round trip. Used to assert the batched resolution issues a single
 * options read regardless of how many exclusive hooks are registered.
 */
function createSelectCountingPlugin(): { plugin: KyselyPlugin; counter: { count: number } } {
	const counter = { count: 0 };
	const plugin: KyselyPlugin = {
		transformQuery(args) {
			if (args.node.kind === "SelectQueryNode") counter.count += 1;
			return args.node;
		},
		transformResult(args) {
			return Promise.resolve(args.result);
		},
	};
	return { plugin, counter };
}

describeEachDialect("PluginManager — batched exclusive hook resolution", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("resolves all exclusive hooks with a single options select", async () => {
		const { plugin: countingPlugin, counter } = createSelectCountingPlugin();
		const db = ctx.db.withPlugin(countingPlugin);

		const manager = new PluginManager({ db });
		manager.register(
			createTestDefinition({
				id: "provider-save",
				hooks: {
					"content:beforeSave": {
						handler: vi.fn() as unknown as ContentBeforeSaveHandler,
						exclusive: true,
					},
				},
			}),
		);
		manager.register(
			createTestDefinition({
				id: "provider-after",
				hooks: {
					"content:afterSave": {
						handler: vi.fn() as unknown as ContentAfterSaveHandler,
						exclusive: true,
					},
				},
			}),
		);
		manager.register(
			createTestDefinition({
				id: "provider-delete",
				hooks: {
					"content:beforeDelete": {
						handler: vi.fn() as unknown as ContentBeforeDeleteHandler,
						exclusive: true,
					},
				},
			}),
		);
		await manager.activate("provider-save");
		await manager.activate("provider-after");
		await manager.activate("provider-delete");

		// All three sole providers were auto-selected during activation;
		// a fresh resolution keeps them with exactly one batched read.
		counter.count = 0;
		await manager.resolveExclusiveHooks();
		expect(counter.count).toBe(1);

		expect(await manager.getExclusiveHookSelection("content:beforeSave")).toBe("provider-save");
		expect(await manager.getExclusiveHookSelection("content:afterSave")).toBe("provider-after");
		expect(await manager.getExclusiveHookSelection("content:beforeDelete")).toBe("provider-delete");
	});
});
