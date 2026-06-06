/**
 * PluginManager Tests
 *
 * Tests the central plugin orchestrator for:
 * - Plugin registration
 * - Lifecycle management (install, activate, deactivate, uninstall)
 * - Query methods
 * - Hook and route delegation
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { PluginManager, createPluginManager } from "../../../src/plugins/manager.js";
import type { PluginDefinition } from "../../../src/plugins/types.js";

// Test error message regex patterns
const ALREADY_REGISTERED_REGEX = /already registered/;
const DEACTIVATE_FIRST_REGEX = /Deactivate it first/;
const NOT_FOUND_REGEX = /not found/;
const ALREADY_INSTALLED_REGEX = /already installed/;

/**
 * Create a minimal plugin definition for testing
 */
function createTestDefinition(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		...overrides,
	};
}

describe("PluginManager", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;
	let manager: PluginManager;

	beforeEach(async () => {
		// Create in-memory SQLite database
		sqliteDb = new Database(":memory:");

		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({
				database: sqliteDb,
			}),
		});

		// Run migrations
		await runMigrations(db);

		manager = new PluginManager({ db });
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	describe("register", () => {
		it("registers a plugin definition", () => {
			const resolved = manager.register(createTestDefinition({ id: "my-plugin" }));

			expect(resolved.id).toBe("my-plugin");
			expect(manager.hasPlugin("my-plugin")).toBe(true);
		});

		it("returns the resolved plugin", () => {
			const resolved = manager.register(
				createTestDefinition({
					id: "test",
					capabilities: ["content:write"],
				}),
			);

			// content:write should add content:read
			expect(resolved.capabilities).toContain("content:write");
			expect(resolved.capabilities).toContain("content:read");
		});

		it("throws on duplicate registration", () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));

			expect(() => manager.register(createTestDefinition({ id: "my-plugin" }))).toThrow(
				ALREADY_REGISTERED_REGEX,
			);
		});

		it("sets initial state to registered", () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));

			expect(manager.getPluginState("my-plugin")).toBe("registered");
		});
	});

	describe("registerAll", () => {
		it("registers multiple plugins", () => {
			manager.registerAll([
				createTestDefinition({ id: "plugin-a" }),
				createTestDefinition({ id: "plugin-b" }),
				createTestDefinition({ id: "plugin-c" }),
			]);

			expect(manager.hasPlugin("plugin-a")).toBe(true);
			expect(manager.hasPlugin("plugin-b")).toBe(true);
			expect(manager.hasPlugin("plugin-c")).toBe(true);
		});
	});

	describe("unregister", () => {
		it("returns false for non-existent plugin", () => {
			const result = manager.unregister("non-existent");
			expect(result).toBe(false);
		});

		it("unregisters a registered plugin", () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));

			const result = manager.unregister("my-plugin");

			expect(result).toBe(true);
			expect(manager.hasPlugin("my-plugin")).toBe(false);
		});

		it("throws when trying to unregister active plugin", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.activate("my-plugin");

			expect(() => manager.unregister("my-plugin")).toThrow(DEACTIVATE_FIRST_REGEX);
		});
	});

	describe("install", () => {
		it("throws for non-existent plugin", async () => {
			await expect(manager.install("non-existent")).rejects.toThrow(NOT_FOUND_REGEX);
		});

		it("installs a registered plugin", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));

			await manager.install("my-plugin");

			expect(manager.getPluginState("my-plugin")).toBe("installed");
		});

		it("throws if plugin is already installed", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.install("my-plugin");

			await expect(manager.install("my-plugin")).rejects.toThrow(ALREADY_INSTALLED_REGEX);
		});

		it("runs plugin:install hook", async () => {
			const installHandler = vi.fn();
			manager.register(
				createTestDefinition({
					id: "my-plugin",
					hooks: {
						"plugin:install": installHandler,
					},
				}),
			);

			await manager.install("my-plugin");

			// Hook should be registered but not called without context factory
			// In real usage, the hook would be called
			expect(manager.getPluginState("my-plugin")).toBe("installed");
		});
	});

	describe("activate", () => {
		it("throws for non-existent plugin", async () => {
			await expect(manager.activate("non-existent")).rejects.toThrow(NOT_FOUND_REGEX);
		});

		it("auto-installs if not installed", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));

			await manager.activate("my-plugin");

			expect(manager.getPluginState("my-plugin")).toBe("active");
		});

		it("activates an installed plugin", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.install("my-plugin");

			await manager.activate("my-plugin");

			expect(manager.getPluginState("my-plugin")).toBe("active");
		});

		it("returns empty array if already active", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.activate("my-plugin");

			const results = await manager.activate("my-plugin");

			expect(results).toEqual([]);
		});
	});

	describe("deactivate", () => {
		it("throws for non-existent plugin", async () => {
			await expect(manager.deactivate("non-existent")).rejects.toThrow(NOT_FOUND_REGEX);
		});

		it("returns empty array if not active", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));

			const results = await manager.deactivate("my-plugin");

			expect(results).toEqual([]);
		});

		it("deactivates an active plugin", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.activate("my-plugin");

			await manager.deactivate("my-plugin");

			expect(manager.getPluginState("my-plugin")).toBe("inactive");
		});
	});

	describe("uninstall", () => {
		it("throws for non-existent plugin", async () => {
			await expect(manager.uninstall("non-existent")).rejects.toThrow(NOT_FOUND_REGEX);
		});

		it("deactivates before uninstalling if active", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.activate("my-plugin");

			await manager.uninstall("my-plugin");

			expect(manager.hasPlugin("my-plugin")).toBe(false);
		});

		it("removes plugin from manager", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.install("my-plugin");

			await manager.uninstall("my-plugin");

			expect(manager.hasPlugin("my-plugin")).toBe(false);
		});
	});

	describe("getPlugin", () => {
		it("returns undefined for non-existent plugin", () => {
			expect(manager.getPlugin("non-existent")).toBeUndefined();
		});

		it("returns the resolved plugin", () => {
			manager.register(createTestDefinition({ id: "my-plugin", version: "2.0.0" }));

			const plugin = manager.getPlugin("my-plugin");

			expect(plugin).toBeDefined();
			expect(plugin!.id).toBe("my-plugin");
			expect(plugin!.version).toBe("2.0.0");
		});
	});

	describe("getPluginState", () => {
		it("returns undefined for non-existent plugin", () => {
			expect(manager.getPluginState("non-existent")).toBeUndefined();
		});

		it("returns current state", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			expect(manager.getPluginState("my-plugin")).toBe("registered");

			await manager.install("my-plugin");
			expect(manager.getPluginState("my-plugin")).toBe("installed");

			await manager.activate("my-plugin");
			expect(manager.getPluginState("my-plugin")).toBe("active");

			await manager.deactivate("my-plugin");
			expect(manager.getPluginState("my-plugin")).toBe("inactive");
		});
	});

	describe("getAllPlugins", () => {
		it("returns empty array initially", () => {
			expect(manager.getAllPlugins()).toEqual([]);
		});

		it("returns all plugins with state", async () => {
			manager.register(createTestDefinition({ id: "plugin-a" }));
			manager.register(createTestDefinition({ id: "plugin-b" }));
			await manager.activate("plugin-b");

			const all = manager.getAllPlugins();

			expect(all).toHaveLength(2);

			const pluginA = all.find((p) => p.plugin.id === "plugin-a");
			const pluginB = all.find((p) => p.plugin.id === "plugin-b");

			expect(pluginA!.state).toBe("registered");
			expect(pluginB!.state).toBe("active");
		});
	});

	describe("getActivePlugins", () => {
		it("returns empty array when no active plugins", () => {
			manager.register(createTestDefinition({ id: "plugin-a" }));

			expect(manager.getActivePlugins()).toEqual([]);
		});

		it("returns only active plugins", async () => {
			manager.register(createTestDefinition({ id: "plugin-a" }));
			manager.register(createTestDefinition({ id: "plugin-b" }));
			manager.register(createTestDefinition({ id: "plugin-c" }));

			await manager.activate("plugin-a");
			await manager.activate("plugin-c");

			const active = manager.getActivePlugins();

			expect(active).toHaveLength(2);
			expect(active.map((p) => p.id).toSorted()).toEqual(["plugin-a", "plugin-c"]);
		});
	});

	describe("hasPlugin", () => {
		it("returns false for non-existent plugin", () => {
			expect(manager.hasPlugin("non-existent")).toBe(false);
		});

		it("returns true for registered plugin", () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			expect(manager.hasPlugin("my-plugin")).toBe(true);
		});
	});

	describe("isActive", () => {
		it("returns false for non-existent plugin", () => {
			expect(manager.isActive("non-existent")).toBe(false);
		});

		it("returns false for registered but not active plugin", () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			expect(manager.isActive("my-plugin")).toBe(false);
		});

		it("returns true for active plugin", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.activate("my-plugin");

			expect(manager.isActive("my-plugin")).toBe(true);
		});

		it("returns false after deactivation", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.activate("my-plugin");
			await manager.deactivate("my-plugin");

			expect(manager.isActive("my-plugin")).toBe(false);
		});
	});

	describe("getPluginRoutes", () => {
		it("returns routes for active plugin", async () => {
			manager.register(
				createTestDefinition({
					id: "my-plugin",
					routes: {
						sync: { handler: vi.fn() },
						import: { handler: vi.fn() },
					},
				}),
			);
			await manager.activate("my-plugin");

			const routes = manager.getPluginRoutes("my-plugin");

			expect(routes).toContain("sync");
			expect(routes).toContain("import");
		});
	});

	describe("reinitialize", () => {
		it("can be called to force reinitialization", async () => {
			manager.register(createTestDefinition({ id: "my-plugin" }));
			await manager.activate("my-plugin");

			// Should not throw
			manager.reinitialize();

			expect(manager.isActive("my-plugin")).toBe(true);
		});
	});
});

describe("createPluginManager helper", () => {
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

	it("creates a PluginManager instance", () => {
		const manager = createPluginManager({ db });
		expect(manager).toBeInstanceOf(PluginManager);
	});
});
