/**
 * Marketplace plugin state tests
 *
 * Tests the PluginStateRepository marketplace extensions:
 * - source/marketplaceVersion fields in upsert
 * - getMarketplacePlugins filter
 * - Migration 022 columns
 */

import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { NodeSqliteCompatDatabase as BetterSqlite3 } from "#node-sqlite";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";

describe("PluginStateRepository – marketplace extensions", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: BetterSqlite3;
	let repo: PluginStateRepository;

	beforeEach(async () => {
		sqliteDb = new BetterSqlite3(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
		await runMigrations(db);
		repo = new PluginStateRepository(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	describe("upsert with marketplace source", () => {
		it("defaults source to 'config' when not specified", async () => {
			const state = await repo.upsert("test-plugin", "1.0.0", "active");
			expect(state.source).toBe("config");
			expect(state.marketplaceVersion).toBeNull();
		});

		it("stores source='marketplace' and marketplaceVersion", async () => {
			const state = await repo.upsert("mp-plugin", "1.0.0", "active", {
				source: "marketplace",
				marketplaceVersion: "1.0.0",
			});
			expect(state.source).toBe("marketplace");
			expect(state.marketplaceVersion).toBe("1.0.0");
		});

		it("updates marketplaceVersion on subsequent upsert", async () => {
			await repo.upsert("mp-plugin", "1.0.0", "active", {
				source: "marketplace",
				marketplaceVersion: "1.0.0",
			});

			const updated = await repo.upsert("mp-plugin", "2.0.0", "active", {
				source: "marketplace",
				marketplaceVersion: "2.0.0",
			});

			expect(updated.version).toBe("2.0.0");
			expect(updated.marketplaceVersion).toBe("2.0.0");
		});
	});

	describe("getMarketplacePlugins", () => {
		it("returns empty array when no marketplace plugins", async () => {
			await repo.upsert("config-plugin", "1.0.0", "active");
			const result = await repo.getMarketplacePlugins();
			expect(result).toEqual([]);
		});

		it("returns only marketplace-sourced plugins", async () => {
			await repo.upsert("config-plugin", "1.0.0", "active");
			await repo.upsert("mp-plugin-a", "1.0.0", "active", {
				source: "marketplace",
				marketplaceVersion: "1.0.0",
			});
			await repo.upsert("mp-plugin-b", "2.0.0", "inactive", {
				source: "marketplace",
				marketplaceVersion: "2.0.0",
			});

			const result = await repo.getMarketplacePlugins();
			expect(result).toHaveLength(2);
			expect(result.map((p) => p.pluginId).toSorted()).toEqual(["mp-plugin-a", "mp-plugin-b"]);
			expect(result.every((p) => p.source === "marketplace")).toBe(true);
		});
	});

	describe("delete marketplace plugin", () => {
		it("deletes marketplace plugin state", async () => {
			await repo.upsert("mp-plugin", "1.0.0", "active", {
				source: "marketplace",
				marketplaceVersion: "1.0.0",
			});

			const deleted = await repo.delete("mp-plugin");
			expect(deleted).toBe(true);

			const state = await repo.get("mp-plugin");
			expect(state).toBeNull();
		});
	});
});
