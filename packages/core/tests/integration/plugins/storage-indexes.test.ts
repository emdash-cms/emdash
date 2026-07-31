import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import {
	createStorageIndexes,
	removeOrphanedIndexes,
	syncStorageIndexes,
	syncDeclaredStorageIndexes,
	removeAllPluginIndexes,
	getPluginIndexStatus,
} from "../../../src/plugins/storage-indexes.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const UNIQUE_CONSTRAINT_PATTERN = /UNIQUE constraint failed/;

describe("Plugin Storage Indexes Integration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("createStorageIndexes", () => {
		it("should create single-field index", async () => {
			const result = await createStorageIndexes(db, "my-plugin", "events", ["eventType"]);

			expect(result.created).toContain("idx_plugin_my-plugin_events_eventType");
			expect(result.errors).toHaveLength(0);
		});

		it("should create composite index", async () => {
			const result = await createStorageIndexes(db, "my-plugin", "events", [
				["status", "createdAt"],
			]);

			expect(result.created).toContain("idx_plugin_my-plugin_events_status_createdAt");
			expect(result.errors).toHaveLength(0);
		});

		it("should create multiple indexes", async () => {
			const result = await createStorageIndexes(db, "my-plugin", "events", [
				"eventType",
				"userId",
				["status", "timestamp"],
			]);

			expect(result.created).toHaveLength(3);
			expect(result.errors).toHaveLength(0);
		});

		it("should track indexes in _plugin_indexes table", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType", "userId"]);

			const indexes = await db
				.selectFrom("_plugin_indexes")
				.selectAll()
				.where("plugin_id", "=", "my-plugin")
				.execute();

			expect(indexes).toHaveLength(2);
			expect(indexes.map((i) => JSON.parse(i.fields))).toContainEqual(["eventType"]);
			expect(indexes.map((i) => JSON.parse(i.fields))).toContainEqual(["userId"]);
		});

		it("accepts collection names that are not SQL identifiers", async () => {
			// The manifest schema allows arbitrary collection keys and the
			// repository stores collection as opaque text — kebab-case names
			// like "form-submissions" must index too.
			const result = await createStorageIndexes(db, "forms", "form-submissions", ["slug"]);

			expect(result.errors).toHaveLength(0);
			expect(result.created).toContain("idx_plugin_forms_form-submissions_slug");

			const indexes = await db
				.selectFrom("_plugin_indexes")
				.select("index_name")
				.where("plugin_id", "=", "forms")
				.execute();
			expect(indexes).toHaveLength(1);
		});

		it("should be idempotent", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType"]);
			const result = await createStorageIndexes(db, "my-plugin", "events", ["eventType"]);

			// Should still succeed
			expect(result.errors).toHaveLength(0);

			// Should not duplicate tracking records
			const indexes = await db
				.selectFrom("_plugin_indexes")
				.selectAll()
				.where("plugin_id", "=", "my-plugin")
				.execute();
			expect(indexes).toHaveLength(1);
		});
	});

	describe("removeOrphanedIndexes", () => {
		it("should remove indexes no longer in declaration", async () => {
			// Create initial indexes
			await createStorageIndexes(db, "my-plugin", "events", ["eventType", "userId", "status"]);

			// Remove one
			const result = await removeOrphanedIndexes(db, "my-plugin", "events", [
				"eventType",
				"userId",
			]);

			expect(result.removed).toContain("idx_plugin_my-plugin_events_status");
			expect(result.errors).toHaveLength(0);
		});

		it("should keep indexes that are still declared", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType", "userId"]);

			const result = await removeOrphanedIndexes(db, "my-plugin", "events", [
				"eventType",
				"userId",
			]);

			expect(result.removed).toHaveLength(0);
		});

		it("should update tracking table", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType", "status"]);
			await removeOrphanedIndexes(db, "my-plugin", "events", ["eventType"]);

			const indexes = await db
				.selectFrom("_plugin_indexes")
				.selectAll()
				.where("plugin_id", "=", "my-plugin")
				.execute();

			expect(indexes).toHaveLength(1);
			expect(JSON.parse(indexes[0].fields)).toEqual(["eventType"]);
		});
	});

	describe("syncStorageIndexes", () => {
		it("should create new and remove old indexes in one call", async () => {
			// Initial state
			await createStorageIndexes(db, "my-plugin", "events", ["eventType", "oldField"]);

			// Sync to new state
			const result = await syncStorageIndexes(db, "my-plugin", "events", ["eventType", "newField"]);

			expect(result.created).toContain("idx_plugin_my-plugin_events_newField");
			expect(result.removed).toContain("idx_plugin_my-plugin_events_oldField");

			const status = await getPluginIndexStatus(db, "my-plugin");
			const fields = status.map((s) => s.fields);
			expect(fields).toContainEqual(["eventType"]);
			expect(fields).toContainEqual(["newField"]);
			expect(fields).not.toContainEqual(["oldField"]);
		});
	});

	describe("removeAllPluginIndexes", () => {
		it("should remove all indexes for a plugin", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType", "userId"]);
			await createStorageIndexes(db, "my-plugin", "cache", ["key", "expiresAt"]);

			const result = await removeAllPluginIndexes(db, "my-plugin");

			expect(result.removed).toHaveLength(4);
			expect(result.errors).toHaveLength(0);

			const remaining = await db
				.selectFrom("_plugin_indexes")
				.selectAll()
				.where("plugin_id", "=", "my-plugin")
				.execute();
			expect(remaining).toHaveLength(0);
		});

		it("should not affect other plugins", async () => {
			await createStorageIndexes(db, "plugin1", "events", ["eventType"]);
			await createStorageIndexes(db, "plugin2", "events", ["eventType"]);

			await removeAllPluginIndexes(db, "plugin1");

			const plugin2Indexes = await db
				.selectFrom("_plugin_indexes")
				.selectAll()
				.where("plugin_id", "=", "plugin2")
				.execute();
			expect(plugin2Indexes).toHaveLength(1);
		});
	});

	describe("getPluginIndexStatus", () => {
		it("should return all indexes for a plugin", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType", ["status", "timestamp"]]);
			await createStorageIndexes(db, "my-plugin", "cache", ["key"]);

			const status = await getPluginIndexStatus(db, "my-plugin");

			expect(status).toHaveLength(3);
			expect(status).toContainEqual(
				expect.objectContaining({
					collection: "events",
					fields: ["eventType"],
				}),
			);
			expect(status).toContainEqual(
				expect.objectContaining({
					collection: "events",
					fields: ["status", "timestamp"],
				}),
			);
			expect(status).toContainEqual(
				expect.objectContaining({
					collection: "cache",
					fields: ["key"],
				}),
			);
		});

		it("should return empty array for plugin with no indexes", async () => {
			const status = await getPluginIndexStatus(db, "nonexistent-plugin");
			expect(status).toEqual([]);
		});
	});

	describe("query performance with indexes", () => {
		it("should efficiently query using indexed fields", async () => {
			const pluginId = "perf-test";
			const collection = "events";

			// Create index first
			await createStorageIndexes(db, pluginId, collection, ["eventType"]);

			// Create repository with the indexed field
			const repo = new PluginStorageRepository<{ eventType: string }>(db, pluginId, collection, [
				"eventType",
			]);

			// Insert test data
			const items = Array.from({ length: 100 }, (_, i) => ({
				id: `event-${i}`,
				data: { eventType: i % 2 === 0 ? "pageview" : "click" },
			}));
			await repo.putMany(items);

			// Query should work and use the index
			const result = await repo.query({
				where: { eventType: "pageview" },
			});

			expect(result.items).toHaveLength(50);
			expect(result.items.every((i) => i.data.eventType === "pageview")).toBe(true);
		});
	});

	describe("index verification", () => {
		it("should create actual SQLite index", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType"]);

			// Query SQLite's index list
			const indexes = await sql<{ name: string }>`
				SELECT name FROM sqlite_master 
				WHERE type = 'index' 
				AND name LIKE 'idx_plugin_%'
			`.execute(db);

			expect(indexes.rows.map((r) => r.name)).toContain("idx_plugin_my-plugin_events_eventType");
		});

		it("should drop actual SQLite index on removal", async () => {
			await createStorageIndexes(db, "my-plugin", "events", ["eventType"]);
			await removeAllPluginIndexes(db, "my-plugin");

			const indexes = await sql<{ name: string }>`
				SELECT name FROM sqlite_master
				WHERE type = 'index'
				AND name LIKE 'idx_plugin_my-plugin_%'
			`.execute(db);

			expect(indexes.rows).toHaveLength(0);
		});
	});

	describe("unique indexes", () => {
		it("should create a unique index", async () => {
			const result = await createStorageIndexes(db, "my-plugin", "forms", [], {
				uniqueIndexes: ["slug"],
			});

			expect(result.created).toContain("uidx_plugin_my-plugin_forms_slug");
			expect(result.errors).toHaveLength(0);

			// Verify it's actually a UNIQUE index in SQLite
			const indexSql = await sql<{ sql: string }>`
				SELECT sql FROM sqlite_master
				WHERE type = 'index'
				AND name = 'uidx_plugin_my-plugin_forms_slug'
			`.execute(db);

			expect(indexSql.rows).toHaveLength(1);
			expect(indexSql.rows[0].sql).toContain("UNIQUE");
		});

		it("should enforce uniqueness on insert", async () => {
			await createStorageIndexes(db, "my-plugin", "forms", [], {
				uniqueIndexes: ["slug"],
			});

			const repo = new PluginStorageRepository<{ slug: string; name: string }>(
				db,
				"my-plugin",
				"forms",
				["slug"],
			);

			await repo.put("form-1", { slug: "contact", name: "Contact" });

			// Second insert with a different ID but same slug should fail
			await expect(repo.put("form-2", { slug: "contact", name: "Contact Copy" })).rejects.toThrow(
				UNIQUE_CONSTRAINT_PATTERN,
			);
		});

		it("should allow updating the same document", async () => {
			await createStorageIndexes(db, "my-plugin", "forms", [], {
				uniqueIndexes: ["slug"],
			});

			const repo = new PluginStorageRepository<{ slug: string; name: string }>(
				db,
				"my-plugin",
				"forms",
				["slug"],
			);

			await repo.put("form-1", { slug: "contact", name: "Contact" });
			// Updating the same ID should succeed (upsert)
			await repo.put("form-1", { slug: "contact", name: "Contact Updated" });

			const result = await repo.get("form-1");
			expect(result?.name).toBe("Contact Updated");
		});

		it("should allow different slugs across different collections", async () => {
			await createStorageIndexes(db, "my-plugin", "forms", [], {
				uniqueIndexes: ["slug"],
			});
			await createStorageIndexes(db, "my-plugin", "templates", [], {
				uniqueIndexes: ["slug"],
			});

			const formsRepo = new PluginStorageRepository<{ slug: string }>(db, "my-plugin", "forms", [
				"slug",
			]);
			const templatesRepo = new PluginStorageRepository<{ slug: string }>(
				db,
				"my-plugin",
				"templates",
				["slug"],
			);

			// Same slug in different collections should work (partial index scoped by collection)
			await formsRepo.put("form-1", { slug: "contact" });
			await templatesRepo.put("tmpl-1", { slug: "contact" });

			expect(await formsRepo.get("form-1")).toEqual({ slug: "contact" });
			expect(await templatesRepo.get("tmpl-1")).toEqual({ slug: "contact" });
		});

		it("should include unique index fields in queryable fields", async () => {
			await createStorageIndexes(db, "my-plugin", "forms", ["status"], {
				uniqueIndexes: ["slug"],
			});

			const repo = new PluginStorageRepository<{ slug: string; status: string }>(
				db,
				"my-plugin",
				"forms",
				["status", "slug"],
			);

			await repo.put("form-1", { slug: "contact", status: "active" });
			await repo.put("form-2", { slug: "feedback", status: "active" });

			// Query by unique field should work
			const result = await repo.query({ where: { slug: "contact" } });
			expect(result.items).toHaveLength(1);
			expect(result.items[0].data.slug).toBe("contact");
		});
	});

	describe("syncDeclaredStorageIndexes", () => {
		it("materializes indexes for every declared collection and is idempotent", async () => {
			const plugins = [
				{ id: "audit-log", storage: { entries: { indexes: ["timestamp"] } } },
				{
					id: "forms",
					storage: { submissions: { indexes: ["formId"], uniqueIndexes: ["token"] } },
				},
			];

			await syncDeclaredStorageIndexes(db, plugins);
			await syncDeclaredStorageIndexes(db, plugins);

			const tracked = await db.selectFrom("_plugin_indexes").select("index_name").execute();
			expect(tracked.map((r) => r.index_name).toSorted()).toEqual([
				"idx_plugin_audit-log_entries_timestamp",
				"idx_plugin_forms_submissions_formId",
				"uidx_plugin_forms_submissions_token",
			]);
		});
	});

	describe("query plan", () => {
		it("serves the repository's ORDER BY from the declared index without a temp B-tree", async () => {
			await createStorageIndexes(db, "audit-log", "entries", ["timestamp"]);

			const repo = new PluginStorageRepository<{ timestamp: string }>(db, "audit-log", "entries", [
				"timestamp",
			]);
			for (let i = 1; i <= 5; i++) {
				await repo.put(`key-${i}`, { timestamp: `2026-07-0${i}T00:00:00.000Z` });
			}

			// Mirror the repository's compiled query() shape: bound parameters for
			// plugin_id/collection (the production reality — D1 never runs ANALYZE,
			// and SQLite won't pick a partial index under bound parameters without
			// statistics).
			const plan = await sql<{ detail: string }>`
				EXPLAIN QUERY PLAN
				SELECT id, data, created_at FROM _plugin_storage
				WHERE plugin_id = ${"audit-log"} AND collection = ${"entries"}
				ORDER BY json_extract(data, '$.timestamp') DESC
				LIMIT 6
			`.execute(db);

			const details = plan.rows.map((r) => r.detail).join("\n");
			expect(details).toContain("idx_plugin_audit-log_entries_timestamp");
			expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		});
	});
});
