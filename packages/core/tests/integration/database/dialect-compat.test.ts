/**
 * Dialect compatibility tests
 *
 * Runs core database operations against every available dialect.
 * SQLite always runs (in-memory). Postgres runs when EMDASH_TEST_PG is set.
 *
 * These tests verify that migrations, schema registry, and content CRUD
 * work identically across dialects.
 */

import { it, expect, beforeEach, afterEach } from "vitest";

import {
	runMigrations,
	getMigrationStatus,
	MIGRATION_COUNT,
} from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	createForDialect,
	describeEachDialect,
	setupForDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describeEachDialect("Migrations", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		// Bare database — no migrations yet. Tests run them explicitly.
		ctx = await createForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("runs all migrations and creates system tables", async () => {
		await runMigrations(ctx.db);

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
			const result = await ctx.db
				.selectFrom(table as keyof Database)
				.selectAll()
				.execute();
			expect(Array.isArray(result), `table ${table} should exist`).toBe(true);
		}
	});

	it("tracks migrations in _emdash_migrations", async () => {
		await runMigrations(ctx.db);

		const migrations = await ctx.db.selectFrom("_emdash_migrations").selectAll().execute();

		expect(migrations).toHaveLength(MIGRATION_COUNT);
		expect(migrations[0]?.name).toBe("001_initial");
	});

	it("is idempotent", async () => {
		await runMigrations(ctx.db);
		await runMigrations(ctx.db);

		const migrations = await ctx.db.selectFrom("_emdash_migrations").selectAll().execute();

		expect(migrations).toHaveLength(MIGRATION_COUNT);
	});

	it("reports correct migration status", async () => {
		const before = await getMigrationStatus(ctx.db);
		expect(before.pending).toContain("001_initial");
		expect(before.applied).toHaveLength(0);

		await runMigrations(ctx.db);

		const after = await getMigrationStatus(ctx.db);
		expect(after.applied).toContain("001_initial");
		expect(after.pending).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

describeEachDialect("Schema registry", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await runMigrations(ctx.db);
		registry = new SchemaRegistry(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates a collection and its dynamic table", async () => {
		await registry.createCollection({
			slug: "article",
			label: "Articles",
			labelSingular: "Article",
		});

		// Dynamic table should exist
		const rows = await ctx.db
			.selectFrom("ec_article" as keyof Database)
			.selectAll()
			.execute();
		expect(Array.isArray(rows)).toBe(true);

		// Registry should have the collection
		const collections = await registry.listCollections();
		expect(collections.map((c) => c.slug)).toContain("article");
	});

	it("adds fields to a collection", async () => {
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});

		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
		});

		await registry.createField("post", {
			slug: "body",
			label: "Body",
			type: "portableText",
		});

		await registry.createField("post", {
			slug: "views",
			label: "Views",
			type: "integer",
		});

		const coll = await registry.getCollectionWithFields("post");
		expect(coll).not.toBeNull();
		const slugs = coll!.fields.map((f) => f.slug);
		expect(slugs).toContain("title");
		expect(slugs).toContain("body");
		expect(slugs).toContain("views");
	});

	it("deletes a collection and drops its table", async () => {
		await registry.createCollection({
			slug: "temp",
			label: "Temp",
			labelSingular: "Temp",
		});

		// Verify it exists
		const before = await registry.listCollections();
		expect(before.map((c) => c.slug)).toContain("temp");

		await registry.deleteCollection("temp");

		const after = await registry.listCollections();
		expect(after.map((c) => c.slug)).not.toContain("temp");
	});
});

// ---------------------------------------------------------------------------
// Content CRUD
// ---------------------------------------------------------------------------

describeEachDialect("Content CRUD", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates and retrieves content", async () => {
		const created = await repo.create({
			type: "post",
			slug: "hello-world",
			data: {
				title: "Hello World",
				content: [{ _type: "block", children: [{ _type: "span", text: "Content" }] }],
			},
			status: "draft",
		});

		expect(created.id).toBeDefined();
		expect(created.slug).toBe("hello-world");

		const found = await repo.findById("post", created.id);
		expect(found).not.toBeNull();
		expect(found!.data.title).toBe("Hello World");
		expect(found!.slug).toBe("hello-world");
	});

	it("updates content", async () => {
		const created = await repo.create({
			type: "post",
			slug: "original",
			data: { title: "Original" },
			status: "draft",
		});

		const updated = await repo.update("post", created.id, {
			data: { title: "Updated" },
		});

		expect(updated.data.title).toBe("Updated");
		expect(updated.slug).toBe("original");
	});

	it("lists content with pagination", async () => {
		for (let i = 0; i < 5; i++) {
			await repo.create({
				type: "post",
				slug: `post-${i}`,
				data: { title: `Post ${i}` },
				status: "draft",
			});
		}

		const result = await repo.findMany("post", { limit: 3 });
		expect(result.items).toHaveLength(3);

		if (result.nextCursor) {
			const page2 = await repo.findMany("post", {
				limit: 3,
				cursor: result.nextCursor,
			});
			expect(page2.items).toHaveLength(2);
		}
	});

	it("soft-deletes content", async () => {
		const created = await repo.create({
			type: "post",
			slug: "to-delete",
			data: { title: "To Delete" },
			status: "draft",
		});

		const deleted = await repo.delete("post", created.id);
		expect(deleted).toBe(true);

		const found = await repo.findById("post", created.id);
		expect(found).toBeNull();
	});

	it("filters by status", async () => {
		await repo.create({
			type: "post",
			slug: "draft-post",
			data: { title: "Draft Post" },
			status: "draft",
		});
		await repo.create({
			type: "post",
			slug: "published-post",
			data: { title: "Published Post" },
			status: "published",
		});

		const drafts = await repo.findMany("post", { where: { status: "draft" } });
		expect(drafts.items).toHaveLength(1);
		expect(drafts.items[0]?.data.title).toBe("Draft Post");

		const published = await repo.findMany("post", { where: { status: "published" } });
		expect(published.items).toHaveLength(1);
		expect(published.items[0]?.data.title).toBe("Published Post");
	});

	it("enforces unique slug within a collection", async () => {
		await repo.create({
			type: "post",
			slug: "same-slug",
			data: { title: "First" },
			status: "draft",
		});

		await expect(
			repo.create({
				type: "post",
				slug: "same-slug",
				data: { title: "Second" },
				status: "draft",
			}),
		).rejects.toThrow();
	});

	it("isolates collections", async () => {
		await repo.create({
			type: "post",
			slug: "shared-slug",
			data: { title: "A Post" },
			status: "draft",
		});
		await repo.create({
			type: "page",
			slug: "shared-slug",
			data: { title: "A Page" },
			status: "draft",
		});

		const posts = await repo.findMany("post");
		const pages = await repo.findMany("page");

		expect(posts.items).toHaveLength(1);
		expect(pages.items).toHaveLength(1);
		expect(posts.items[0]?.data.title).toBe("A Post");
		expect(pages.items[0]?.data.title).toBe("A Page");
	});
});
