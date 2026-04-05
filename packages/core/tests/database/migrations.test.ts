import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../src/database/connection.js";
import { runMigrations, getMigrationStatus } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";

describe("Database Migrations", () => {
	let db: Kysely<Database>;

	beforeEach(() => {
		// Fresh in-memory database for each test
		db = createDatabase({ url: ":memory:" });
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("getMigrationStatus", () => {
		it("should return all migrations as pending for fresh database", async () => {
			const status = await getMigrationStatus(db);

			expect(status.applied).toEqual([]);
			expect(status.pending).toContain("001_initial");
		});

		it("should create migrations tracking table when running migrations", async () => {
			// Note: getMigrationStatus doesn't create the table, runMigrations does
			await runMigrations(db);

			// Verify table was created
			const tables = await db.introspection.getTables();
			const migrationTable = tables.find((t) => t.name === "_emdash_migrations");
			expect(migrationTable).toBeDefined();
		});
	});

	describe("runMigrations", () => {
		it("should run all pending migrations on fresh database", async () => {
			await runMigrations(db);

			const status = await getMigrationStatus(db);
			expect(status.pending).toEqual([]);
			expect(status.applied).toContain("001_initial");
		});

		it("should create all tables from initial migration", async () => {
			await runMigrations(db);

			const tables = await db.introspection.getTables();
			const tableNames = tables.map((t) => t.name);

			// Core system tables (no generic "content" table - collections create ec_* tables)
			expect(tableNames).toContain("revisions");
			expect(tableNames).toContain("taxonomies");
			expect(tableNames).toContain("content_taxonomies");
			expect(tableNames).toContain("media");
			expect(tableNames).toContain("users");
			expect(tableNames).toContain("options");
			expect(tableNames).toContain("audit_logs");
			expect(tableNames).toContain("_emdash_migrations");
			// Schema registry tables
			expect(tableNames).toContain("_emdash_collections");
			expect(tableNames).toContain("_emdash_fields");
		});

		it("should be idempotent - running twice should not error", async () => {
			await runMigrations(db);
			await expect(runMigrations(db)).resolves.not.toThrow();

			const status = await getMigrationStatus(db);
			expect(status.applied).toHaveLength(32); // 001_initial through 033_backfill_url_patterns (no 010)
		});

		it("should record migration in tracking table", async () => {
			await runMigrations(db);

			const records = await db.selectFrom("_emdash_migrations").selectAll().execute();

			expect(records).toHaveLength(32);
			expect(records[0].name).toBe("001_initial");
			expect(records[0].timestamp).toBeDefined();
			expect(records[1].name).toBe("002_media_status");
			expect(records[1].timestamp).toBeDefined();
			expect(records[2].name).toBe("003_schema_registry");
			expect(records[2].timestamp).toBeDefined();
			expect(records[3].name).toBe("004_plugins");
			expect(records[3].timestamp).toBeDefined();
			expect(records[4].name).toBe("005_menus");
			expect(records[4].timestamp).toBeDefined();
			expect(records[5].name).toBe("006_taxonomy_defs");
			expect(records[5].timestamp).toBeDefined();
			expect(records[6].name).toBe("007_widgets");
			expect(records[6].timestamp).toBeDefined();
			expect(records[7].name).toBe("008_auth");
			expect(records[7].timestamp).toBeDefined();
			expect(records[8].name).toBe("009_user_disabled");
			expect(records[8].timestamp).toBeDefined();
			expect(records[9].name).toBe("011_sections");
			expect(records[9].timestamp).toBeDefined();
			expect(records[10].name).toBe("012_search");
			expect(records[10].timestamp).toBeDefined();
			expect(records[11].name).toBe("013_scheduled_publishing");
			expect(records[11].timestamp).toBeDefined();
			expect(records[12].name).toBe("014_draft_revisions");
			expect(records[12].timestamp).toBeDefined();
			expect(records[13].name).toBe("015_indexes");
			expect(records[13].timestamp).toBeDefined();
			expect(records[14].name).toBe("016_api_tokens");
			expect(records[14].timestamp).toBeDefined();
			expect(records[15].name).toBe("017_authorization_codes");
			expect(records[15].timestamp).toBeDefined();
		});
	});

	describe("schema registry tables", () => {
		beforeEach(async () => {
			await runMigrations(db);
		});

		it("should have _emdash_collections table with correct columns", async () => {
			const tables = await db.introspection.getTables();
			const collectionsTable = tables.find((t) => t.name === "_emdash_collections");

			expect(collectionsTable).toBeDefined();
			const columns = collectionsTable!.columns.map((c) => c.name);

			expect(columns).toContain("id");
			expect(columns).toContain("slug");
			expect(columns).toContain("label");
			expect(columns).toContain("label_singular");
			expect(columns).toContain("description");
			expect(columns).toContain("icon");
			expect(columns).toContain("supports");
			expect(columns).toContain("source");
			expect(columns).toContain("created_at");
			expect(columns).toContain("updated_at");
		});

		it("should have _emdash_fields table with correct columns", async () => {
			const tables = await db.introspection.getTables();
			const fieldsTable = tables.find((t) => t.name === "_emdash_fields");

			expect(fieldsTable).toBeDefined();
			const columns = fieldsTable!.columns.map((c) => c.name);

			expect(columns).toContain("id");
			expect(columns).toContain("collection_id");
			expect(columns).toContain("slug");
			expect(columns).toContain("label");
			expect(columns).toContain("type");
			expect(columns).toContain("column_type");
			expect(columns).toContain("required");
			expect(columns).toContain("unique");
			expect(columns).toContain("default_value");
			expect(columns).toContain("validation");
			expect(columns).toContain("widget");
			expect(columns).toContain("options");
			expect(columns).toContain("sort_order");
			expect(columns).toContain("created_at");
		});

		it("should enforce unique constraint on collection slug", async () => {
			await db
				.insertInto("_emdash_collections")
				.values({
					id: "1",
					slug: "posts",
					label: "Posts",
				})
				.execute();

			await expect(
				db
					.insertInto("_emdash_collections")
					.values({
						id: "2",
						slug: "posts",
						label: "Posts Again",
					})
					.execute(),
			).rejects.toThrow();
		});
	});

	describe("users table schema", () => {
		beforeEach(async () => {
			await runMigrations(db);
		});

		it("should enforce unique constraint on email", async () => {
			await db
				.insertInto("users")
				.values({
					id: "1",
					email: "test@example.com",
					role: 50, // ADMIN
				})
				.execute();

			await expect(
				db
					.insertInto("users")
					.values({
						id: "2",
						email: "test@example.com",
						role: 40, // EDITOR
					})
					.execute(),
			).rejects.toThrow();
		});

		it("should have auth-related tables", async () => {
			const tables = await db.introspection.getTables();
			const tableNames = tables.map((t) => t.name);

			expect(tableNames).toContain("credentials");
			expect(tableNames).toContain("auth_tokens");
			expect(tableNames).toContain("oauth_accounts");
			expect(tableNames).toContain("allowed_domains");
		});
	});

	describe("revisions table", () => {
		beforeEach(async () => {
			await runMigrations(db);
		});

		it("should have correct columns for per-collection architecture", async () => {
			const tables = await db.introspection.getTables();
			const revisionsTable = tables.find((t) => t.name === "revisions");

			expect(revisionsTable).toBeDefined();
			const columns = revisionsTable!.columns.map((c) => c.name);

			// Revisions now reference collection + entry_id instead of content_id
			expect(columns).toContain("id");
			expect(columns).toContain("collection");
			expect(columns).toContain("entry_id");
			expect(columns).toContain("data");
			expect(columns).toContain("created_at");
		});

		it("should store revision data", async () => {
			await db
				.insertInto("revisions")
				.values({
					id: "rev-1",
					collection: "posts",
					entry_id: "entry-1",
					data: JSON.stringify({ title: "Original Title" }),
				})
				.execute();

			const revisions = await db
				.selectFrom("revisions")
				.where("collection", "=", "posts")
				.where("entry_id", "=", "entry-1")
				.selectAll()
				.execute();

			expect(revisions).toHaveLength(1);
			expect(JSON.parse(revisions[0].data)).toEqual({
				title: "Original Title",
			});
		});
	});

	describe("media table", () => {
		beforeEach(async () => {
			await runMigrations(db);
		});

		it("should have correct columns", async () => {
			const tables = await db.introspection.getTables();
			const mediaTable = tables.find((t) => t.name === "media");

			expect(mediaTable).toBeDefined();
			const columns = mediaTable!.columns.map((c) => c.name);

			expect(columns).toContain("id");
			expect(columns).toContain("filename");
			expect(columns).toContain("mime_type");
			expect(columns).toContain("size");
			expect(columns).toContain("storage_key");
		});
	});
});
