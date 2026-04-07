import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations, getMigrationStatus } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";

describe("Database Migrations (Integration)", () => {
	let db: Kysely<Database>;

	beforeEach(() => {
		// Create fresh in-memory database for each test
		db = createDatabase({ url: ":memory:" });
	});

	afterEach(async () => {
		// Close the database connection
		await db.destroy();
	});

	it("should create all tables from migrations", async () => {
		await runMigrations(db);

		// Verify all tables exist by querying them
		// Note: No generic "content" table - collections create ec_* tables dynamically
		const tables = [
			"revisions",
			"taxonomies",
			"content_taxonomies",
			"media",
			"users",
			"options",
			"audit_logs",
			"_emdash_migrations",
			"_emdash_collections",
			"_emdash_fields",
			"_plugin_storage",
			"_plugin_state",
			"_plugin_indexes",
			"_emdash_sections",
			"_emdash_bylines",
			"_emdash_content_bylines",
		];

		for (const table of tables) {
			// Query table to verify it exists
			const result = await db
				.selectFrom(table as keyof Database)
				.selectAll()
				.execute();
			expect(Array.isArray(result)).toBe(true);
		}
	});

	it("should track migration in _emdash_migrations table", async () => {
		await runMigrations(db);

		const migrations = await db.selectFrom("_emdash_migrations").selectAll().execute();

		expect(migrations).toHaveLength(32);
		expect(migrations[0]?.name).toBe("001_initial");
		expect(migrations[0]?.timestamp).toBeDefined();
		expect(migrations[1]?.name).toBe("002_media_status");
		expect(migrations[1]?.timestamp).toBeDefined();
		expect(migrations[2]?.name).toBe("003_schema_registry");
		expect(migrations[2]?.timestamp).toBeDefined();
		expect(migrations[3]?.name).toBe("004_plugins");
		expect(migrations[3]?.timestamp).toBeDefined();
		expect(migrations[4]?.name).toBe("005_menus");
		expect(migrations[4]?.timestamp).toBeDefined();
		expect(migrations[5]?.name).toBe("006_taxonomy_defs");
		expect(migrations[5]?.timestamp).toBeDefined();
		expect(migrations[6]?.name).toBe("007_widgets");
		expect(migrations[6]?.timestamp).toBeDefined();
		expect(migrations[7]?.name).toBe("008_auth");
		expect(migrations[7]?.timestamp).toBeDefined();
		expect(migrations[8]?.name).toBe("009_user_disabled");
		expect(migrations[8]?.timestamp).toBeDefined();
		expect(migrations[9]?.name).toBe("011_sections");
		expect(migrations[9]?.timestamp).toBeDefined();
		expect(migrations[10]?.name).toBe("012_search");
		expect(migrations[10]?.timestamp).toBeDefined();
		expect(migrations[11]?.name).toBe("013_scheduled_publishing");
		expect(migrations[11]?.timestamp).toBeDefined();
		expect(migrations[12]?.name).toBe("014_draft_revisions");
		expect(migrations[12]?.timestamp).toBeDefined();
		expect(migrations[13]?.name).toBe("015_indexes");
		expect(migrations[13]?.timestamp).toBeDefined();
		expect(migrations[14]?.name).toBe("016_api_tokens");
		expect(migrations[14]?.timestamp).toBeDefined();
		expect(migrations[15]?.name).toBe("017_authorization_codes");
		expect(migrations[15]?.timestamp).toBeDefined();
	});

	it("should be idempotent (running twice is safe)", async () => {
		await runMigrations(db);
		await runMigrations(db);

		const migrations = await db.selectFrom("_emdash_migrations").selectAll().execute();

		// Should still only have thirty-two migration records
		expect(migrations).toHaveLength(32);
	});

	it("should report correct migration status", async () => {
		const statusBefore = await getMigrationStatus(db);
		expect(statusBefore.pending).toContain("001_initial");
		expect(statusBefore.pending).toContain("002_media_status");
		expect(statusBefore.applied).toHaveLength(0);

		await runMigrations(db);

		const statusAfter = await getMigrationStatus(db);
		expect(statusAfter.applied).toContain("001_initial");
		expect(statusAfter.applied).toContain("002_media_status");
		expect(statusAfter.pending).toHaveLength(0);
	});

	it("should create schema registry tables", async () => {
		await runMigrations(db);

		// Test collections table
		const testId = "test-collection";
		await db
			.insertInto("_emdash_collections")
			.values({
				id: testId,
				slug: "posts",
				label: "Posts",
				label_singular: "Post",
			})
			.execute();

		const collection = await db
			.selectFrom("_emdash_collections")
			.selectAll()
			.where("id", "=", testId)
			.executeTakeFirst();

		expect(collection).toBeDefined();
		expect(collection?.slug).toBe("posts");
		expect(collection?.label).toBe("Posts");
		expect(collection?.created_at).toBeDefined();
	});

	it("should enforce unique constraint on collection slug", async () => {
		await runMigrations(db);

		await db
			.insertInto("_emdash_collections")
			.values({
				id: "id1",
				slug: "posts",
				label: "Posts",
			})
			.execute();

		// Attempting to insert duplicate slug should fail
		await expect(
			db
				.insertInto("_emdash_collections")
				.values({
					id: "id2",
					slug: "posts",
					label: "Posts Again",
				})
				.execute(),
		).rejects.toThrow();
	});

	it("should create fields table with foreign key to collections", async () => {
		await runMigrations(db);

		// Create collection first
		const collectionId = "collection-1";
		await db
			.insertInto("_emdash_collections")
			.values({
				id: collectionId,
				slug: "posts",
				label: "Posts",
			})
			.execute();

		// Create field
		await db
			.insertInto("_emdash_fields")
			.values({
				id: "field-1",
				collection_id: collectionId,
				slug: "title",
				label: "Title",
				type: "string",
				column_type: "TEXT",
				required: 0,
				unique: 0,
				sort_order: 0,
			})
			.execute();

		const fields = await db
			.selectFrom("_emdash_fields")
			.selectAll()
			.where("collection_id", "=", collectionId)
			.execute();

		expect(fields).toHaveLength(1);
		expect(fields[0]?.slug).toBe("title");
	});

	it("should create revisions table with collection+entry_id", async () => {
		await runMigrations(db);

		// Create revision for a content entry
		await db
			.insertInto("revisions")
			.values({
				id: "rev-1",
				collection: "posts",
				entry_id: "entry-1",
				data: JSON.stringify({ title: "Revised" }),
			})
			.execute();

		const revisions = await db
			.selectFrom("revisions")
			.selectAll()
			.where("collection", "=", "posts")
			.where("entry_id", "=", "entry-1")
			.execute();

		expect(revisions).toHaveLength(1);
		expect(revisions[0]?.collection).toBe("posts");
	});

	it("should create users table with unique email constraint", async () => {
		await runMigrations(db);

		await db
			.insertInto("users")
			.values({
				id: "user-1",
				email: "test@example.com",
				name: "Test User",
				role: 50, // ADMIN
				email_verified: 1,
			})
			.execute();

		// Duplicate email should fail
		await expect(
			db
				.insertInto("users")
				.values({
					id: "user-2",
					email: "test@example.com",
					role: 10, // SUBSCRIBER
					email_verified: 1,
				})
				.execute(),
		).rejects.toThrow();
	});

	it("should create taxonomies table with hierarchical support", async () => {
		await runMigrations(db);

		// Create parent category
		const parentId = "cat-parent";
		await db
			.insertInto("taxonomies")
			.values({
				id: parentId,
				name: "category",
				slug: "parent",
				label: "Parent Category",
			})
			.execute();

		// Create child category
		await db
			.insertInto("taxonomies")
			.values({
				id: "cat-child",
				name: "category",
				slug: "child",
				label: "Child Category",
				parent_id: parentId,
			})
			.execute();

		const child = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("id", "=", "cat-child")
			.executeTakeFirst();

		expect(child?.parent_id).toBe(parentId);
	});

	it("should create content_taxonomies junction table", async () => {
		await runMigrations(db);

		const taxonomyId = "tax-1";

		// Create taxonomy
		await db
			.insertInto("taxonomies")
			.values({
				id: taxonomyId,
				name: "category",
				slug: "tech",
				label: "Technology",
			})
			.execute();

		// Assign taxonomy to content entry (collection + entry_id)
		await db
			.insertInto("content_taxonomies")
			.values({
				collection: "posts",
				entry_id: "entry-1",
				taxonomy_id: taxonomyId,
			})
			.execute();

		const assignments = await db
			.selectFrom("content_taxonomies")
			.selectAll()
			.where("collection", "=", "posts")
			.where("entry_id", "=", "entry-1")
			.execute();

		expect(assignments).toHaveLength(1);
		expect(assignments[0]?.taxonomy_id).toBe(taxonomyId);
	});

	it("should create media table", async () => {
		await runMigrations(db);

		await db
			.insertInto("media")
			.values({
				id: "media-1",
				filename: "photo.jpg",
				mime_type: "image/jpeg",
				size: 1024000,
				width: 1920,
				height: 1080,
				alt: "Test photo",
				storage_key: "uploads/photo.jpg",
				status: "ready",
			})
			.execute();

		const media = await db
			.selectFrom("media")
			.selectAll()
			.where("id", "=", "media-1")
			.executeTakeFirst();

		expect(media).toBeDefined();
		expect(media?.width).toBe(1920);
		expect(media?.height).toBe(1080);
	});

	it("should create options table for key-value storage", async () => {
		await runMigrations(db);

		await db
			.insertInto("options")
			.values({
				name: "site_title",
				value: JSON.stringify("My Site"),
			})
			.execute();

		const option = await db
			.selectFrom("options")
			.selectAll()
			.where("name", "=", "site_title")
			.executeTakeFirst();

		expect(option).toBeDefined();
		expect(JSON.parse(option!.value)).toBe("My Site");
	});

	it("should create audit_logs table with indexes", async () => {
		await runMigrations(db);

		await db
			.insertInto("audit_logs")
			.values({
				id: "log-1",
				actor_id: "user-1",
				actor_ip: "192.168.1.1",
				action: "content:create",
				resource_type: "content",
				resource_id: "post-1",
				status: "success",
			})
			.execute();

		const logs = await db
			.selectFrom("audit_logs")
			.selectAll()
			.where("actor_id", "=", "user-1")
			.execute();

		expect(logs).toHaveLength(1);
		expect(logs[0]?.action).toBe("content:create");
	});
});
