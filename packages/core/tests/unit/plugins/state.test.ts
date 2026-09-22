/**
 * PluginStateRepository Tests
 *
 * Tests the database-backed plugin state storage for:
 * - CRUD operations (get, getAll, upsert, delete)
 * - Enable/disable convenience methods
 * - Timestamp tracking
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";

describe("PluginStateRepository", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;
	let repo: PluginStateRepository;

	beforeEach(async () => {
		// Create in-memory SQLite database
		sqliteDb = new Database(":memory:");

		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({
				database: sqliteDb,
			}),
		});

		// Run migrations to create tables
		await runMigrations(db);

		repo = new PluginStateRepository(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	describe("get", () => {
		it("returns null for non-existent plugin", async () => {
			const state = await repo.get("non-existent");
			expect(state).toBeNull();
		});

		it("returns state for existing plugin", async () => {
			// Insert directly
			await db
				.insertInto("_plugin_state")
				.values({
					plugin_id: "test-plugin",
					status: "active",
					version: "1.0.0",
					installed_at: new Date().toISOString(),
					activated_at: new Date().toISOString(),
					deactivated_at: null,
					data: null,
				})
				.execute();

			const state = await repo.get("test-plugin");

			expect(state).not.toBeNull();
			expect(state!.pluginId).toBe("test-plugin");
			expect(state!.status).toBe("active");
			expect(state!.version).toBe("1.0.0");
		});

		it("parses dates correctly", async () => {
			const now = new Date();
			await db
				.insertInto("_plugin_state")
				.values({
					plugin_id: "test-plugin",
					status: "inactive",
					version: "2.0.0",
					installed_at: now.toISOString(),
					activated_at: now.toISOString(),
					deactivated_at: now.toISOString(),
					data: null,
				})
				.execute();

			const state = await repo.get("test-plugin");

			expect(state!.installedAt).toBeInstanceOf(Date);
			expect(state!.activatedAt).toBeInstanceOf(Date);
			expect(state!.deactivatedAt).toBeInstanceOf(Date);
		});

		it("parses zone-less database timestamps as UTC", async () => {
			const previousTimezone = process.env.TZ;
			process.env.TZ = "America/Los_Angeles";

			try {
				await db
					.insertInto("_plugin_state")
					.values({
						plugin_id: "test-plugin",
						status: "active",
						version: "1.0.0",
						installed_at: "2026-08-31 12:34:56",
						activated_at: "2026-08-31 12:34:56",
						deactivated_at: null,
						data: null,
					})
					.execute();

				const state = await repo.get("test-plugin");

				expect(state!.installedAt.toISOString()).toBe("2026-08-31T12:34:56.000Z");
				expect(state!.activatedAt!.toISOString()).toBe("2026-08-31T12:34:56.000Z");
			} finally {
				if (previousTimezone === undefined) delete process.env.TZ;
				else process.env.TZ = previousTimezone;
			}
		});

		it("parses PostgreSQL hour-only timezone offsets", async () => {
			await db
				.insertInto("_plugin_state")
				.values({
					plugin_id: "test-plugin",
					status: "active",
					version: "1.0.0",
					installed_at: "2026-08-31 12:34:56.123456+00",
					activated_at: null,
					deactivated_at: null,
					data: null,
				})
				.execute();

			const state = await repo.get("test-plugin");

			expect(state!.installedAt.toISOString()).toBe("2026-08-31T12:34:56.123Z");
		});

		it("handles null dates", async () => {
			await db
				.insertInto("_plugin_state")
				.values({
					plugin_id: "test-plugin",
					status: "inactive",
					version: "1.0.0",
					installed_at: new Date().toISOString(),
					activated_at: null,
					deactivated_at: null,
					data: null,
				})
				.execute();

			const state = await repo.get("test-plugin");

			expect(state!.activatedAt).toBeNull();
			expect(state!.deactivatedAt).toBeNull();
		});
	});

	describe("getAll", () => {
		it("returns empty array when no plugins", async () => {
			const states = await repo.getAll();
			expect(states).toEqual([]);
		});

		it("returns all plugin states", async () => {
			await db
				.insertInto("_plugin_state")
				.values([
					{
						plugin_id: "plugin-a",
						status: "active",
						version: "1.0.0",
						installed_at: new Date().toISOString(),
						activated_at: new Date().toISOString(),
						deactivated_at: null,
						data: null,
					},
					{
						plugin_id: "plugin-b",
						status: "inactive",
						version: "2.0.0",
						installed_at: new Date().toISOString(),
						activated_at: null,
						deactivated_at: null,
						data: null,
					},
				])
				.execute();

			const states = await repo.getAll();

			expect(states).toHaveLength(2);
			expect(states.map((s) => s.pluginId).toSorted()).toEqual(["plugin-a", "plugin-b"]);
		});
	});

	describe("upsert", () => {
		it("creates new state when plugin does not exist", async () => {
			const state = await repo.upsert("new-plugin", "1.0.0", "active");

			expect(state.pluginId).toBe("new-plugin");
			expect(state.version).toBe("1.0.0");
			expect(state.status).toBe("active");
			expect(state.installedAt).toBeInstanceOf(Date);
		});

		it("updates existing state", async () => {
			// Create initial state
			await repo.upsert("test-plugin", "1.0.0", "active");

			// Update it
			const state = await repo.upsert("test-plugin", "1.1.0", "inactive");

			expect(state.pluginId).toBe("test-plugin");
			expect(state.version).toBe("1.1.0");
			expect(state.status).toBe("inactive");
		});

		it("sets activated_at when activating", async () => {
			// Create as inactive
			await repo.upsert("test-plugin", "1.0.0", "inactive");

			// Activate
			const state = await repo.upsert("test-plugin", "1.0.0", "active");

			expect(state.activatedAt).toBeInstanceOf(Date);
		});

		it("sets deactivated_at when deactivating", async () => {
			// Create as active
			await repo.upsert("test-plugin", "1.0.0", "active");

			// Deactivate
			const state = await repo.upsert("test-plugin", "1.0.0", "inactive");

			expect(state.deactivatedAt).toBeInstanceOf(Date);
		});

		it("does not change activated_at if already active", async () => {
			// Create as active
			const initial = await repo.upsert("test-plugin", "1.0.0", "active");
			const initialActivatedAt = initial.activatedAt!.getTime();

			// Wait a bit then update version (still active)
			await new Promise((r) => setTimeout(r, 10));
			const updated = await repo.upsert("test-plugin", "1.1.0", "active");

			// activated_at should be the same
			expect(updated.activatedAt!.getTime()).toBe(initialActivatedAt);
		});
	});

	describe("enable", () => {
		it("creates active state for new plugin", async () => {
			const state = await repo.enable("new-plugin", "1.0.0");

			expect(state.status).toBe("active");
			expect(state.activatedAt).toBeInstanceOf(Date);
		});

		it("activates inactive plugin", async () => {
			await repo.upsert("test-plugin", "1.0.0", "inactive");

			const state = await repo.enable("test-plugin", "1.0.0");

			expect(state.status).toBe("active");
		});
	});

	describe("disable", () => {
		it("creates inactive state for new plugin", async () => {
			const state = await repo.disable("new-plugin", "1.0.0");

			expect(state.status).toBe("inactive");
			expect(state.activatedAt).toBeNull();
		});

		it("deactivates active plugin", async () => {
			await repo.upsert("test-plugin", "1.0.0", "active");

			const state = await repo.disable("test-plugin", "1.0.0");

			expect(state.status).toBe("inactive");
			expect(state.deactivatedAt).toBeInstanceOf(Date);
		});
	});

	describe("delete", () => {
		it("returns false for non-existent plugin", async () => {
			const deleted = await repo.delete("non-existent");
			expect(deleted).toBe(false);
		});

		it("deletes existing plugin and returns true", async () => {
			await repo.upsert("test-plugin", "1.0.0", "active");

			const deleted = await repo.delete("test-plugin");

			expect(deleted).toBe(true);

			// Verify it's gone
			const state = await repo.get("test-plugin");
			expect(state).toBeNull();
		});

		it("only deletes specified plugin", async () => {
			await repo.upsert("plugin-a", "1.0.0", "active");
			await repo.upsert("plugin-b", "1.0.0", "active");

			await repo.delete("plugin-a");

			const stateA = await repo.get("plugin-a");
			const stateB = await repo.get("plugin-b");

			expect(stateA).toBeNull();
			expect(stateB).not.toBeNull();
		});
	});
});
