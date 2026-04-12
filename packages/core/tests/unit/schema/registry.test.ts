import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { SchemaRegistry, SchemaError } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";

describe("SchemaRegistry", () => {
	let db: Kysely<EmDashDatabase>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		// Create in-memory database
		const sqlite = new Database(":memory:");
		db = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		// Run migrations
		await runMigrations(db);

		// Create registry
		registry = new SchemaRegistry(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("Collection Operations", () => {
		it("should create a collection", async () => {
			const collection = await registry.createCollection({
				slug: "posts",
				label: "Blog Posts",
				labelSingular: "Post",
				supports: ["drafts", "revisions"],
			});

			expect(collection.slug).toBe("posts");
			expect(collection.label).toBe("Blog Posts");
			expect(collection.labelSingular).toBe("Post");
			expect(collection.supports).toEqual(["drafts", "revisions"]);
			expect(collection.source).toBe("manual");
			expect(collection.id).toBeDefined();
		});

		it("should create the content table when creating a collection", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
			});

			// Verify table exists by inserting a row
			const result = await db
				.insertInto("ec_articles" as any)
				.values({
					id: "test-id",
					slug: "test-slug",
					status: "draft",
				})
				.execute();

			expect(result).toBeDefined();
		});

		it("should list collections", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createCollection({ slug: "pages", label: "Pages" });

			const collections = await registry.listCollections();

			expect(collections).toHaveLength(2);
			expect(collections.map((c) => c.slug)).toEqual(["pages", "posts"]); // sorted
		});

		it("should get a collection by slug", async () => {
			await registry.createCollection({
				slug: "products",
				label: "Products",
				description: "Store products",
			});

			const collection = await registry.getCollection("products");

			expect(collection).not.toBeNull();
			expect(collection?.slug).toBe("products");
			expect(collection?.description).toBe("Store products");
		});

		it("should return null for non-existent collection", async () => {
			const collection = await registry.getCollection("nonexistent");
			expect(collection).toBeNull();
		});

		it("should update a collection", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });

			const updated = await registry.updateCollection("posts", {
				label: "Blog Posts",
				description: "All blog posts",
				supports: ["drafts"],
			});

			expect(updated.label).toBe("Blog Posts");
			expect(updated.description).toBe("All blog posts");
			expect(updated.supports).toEqual(["drafts"]);
		});

		it("should throw when updating non-existent collection", async () => {
			await expect(registry.updateCollection("nonexistent", { label: "Test" })).rejects.toThrow(
				SchemaError,
			);
		});

		it("should delete a collection", async () => {
			await registry.createCollection({ slug: "temp", label: "Temp" });

			await registry.deleteCollection("temp");

			const collection = await registry.getCollection("temp");
			expect(collection).toBeNull();
		});

		it("should throw when creating duplicate collection", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });

			await expect(registry.createCollection({ slug: "posts", label: "Posts 2" })).rejects.toThrow(
				SchemaError,
			);
		});

		it("should reject reserved collection slugs", async () => {
			await expect(
				registry.createCollection({ slug: "content", label: "Content" }),
			).rejects.toThrow(SchemaError);

			await expect(registry.createCollection({ slug: "users", label: "Users" })).rejects.toThrow(
				SchemaError,
			);
		});

		it("should validate collection slug format", async () => {
			await expect(registry.createCollection({ slug: "My Posts", label: "Posts" })).rejects.toThrow(
				SchemaError,
			);

			await expect(registry.createCollection({ slug: "123posts", label: "Posts" })).rejects.toThrow(
				SchemaError,
			);

			await expect(
				registry.createCollection({ slug: "posts-here", label: "Posts" }),
			).rejects.toThrow(SchemaError);
		});
	});

	describe("Field Operations", () => {
		beforeEach(async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });
		});

		it("should create a field", async () => {
			const field = await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
				required: true,
			});

			expect(field.slug).toBe("title");
			expect(field.label).toBe("Title");
			expect(field.type).toBe("string");
			expect(field.columnType).toBe("TEXT");
			expect(field.required).toBe(true);
		});

		it("should add column to content table when creating field", async () => {
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			// Verify column exists by inserting a row with the field
			await db
				.insertInto("ec_posts" as any)
				.values({
					id: "test-id",
					title: "Test Title",
				})
				.execute();

			const row = await db
				.selectFrom("ec_posts" as any)
				.selectAll()
				.executeTakeFirst();

			expect((row as any).title).toBe("Test Title");
		});

		it("should list fields for a collection", async () => {
			const collection = await registry.getCollection("posts");
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			await registry.createField("posts", {
				slug: "content",
				label: "Content",
				type: "portableText",
			});

			const fields = await registry.listFields(collection!.id);

			expect(fields).toHaveLength(2);
			expect(fields[0].slug).toBe("title");
			expect(fields[1].slug).toBe("content");
		});

		it("should get a field by slug", async () => {
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
				validation: { minLength: 1, maxLength: 100 },
			});

			const field = await registry.getField("posts", "title");

			expect(field).not.toBeNull();
			expect(field?.validation).toEqual({ minLength: 1, maxLength: 100 });
		});

		it("should update a field", async () => {
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const updated = await registry.updateField("posts", "title", {
				label: "Post Title",
				required: true,
				widget: "text",
			});

			expect(updated.label).toBe("Post Title");
			expect(updated.required).toBe(true);
			expect(updated.widget).toBe("text");
		});

		it("should delete a field", async () => {
			await registry.createField("posts", {
				slug: "temp_field",
				label: "Temp",
				type: "string",
			});

			await registry.deleteField("posts", "temp_field");

			const field = await registry.getField("posts", "temp_field");
			expect(field).toBeNull();
		});

		it("should reject reserved field slugs", async () => {
			await expect(
				registry.createField("posts", {
					slug: "id",
					label: "ID",
					type: "string",
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "created_at",
					label: "Created",
					type: "datetime",
				}),
			).rejects.toThrow(SchemaError);
		});

		it("should map field types to correct column types", async () => {
			const testCases: Array<{ type: any; slug: string; expected: string }> = [
				{ type: "string", slug: "f_string", expected: "TEXT" },
				{ type: "text", slug: "f_text", expected: "TEXT" },
				{ type: "number", slug: "f_number", expected: "REAL" },
				{ type: "integer", slug: "f_integer", expected: "INTEGER" },
				{ type: "boolean", slug: "f_boolean", expected: "INTEGER" },
				{ type: "datetime", slug: "f_datetime", expected: "TEXT" },
				{ type: "portableText", slug: "f_portable", expected: "JSON" },
				{ type: "json", slug: "f_json", expected: "JSON" },
				{ type: "image", slug: "f_image", expected: "TEXT" },
				{ type: "reference", slug: "f_reference", expected: "TEXT" },
			];

			for (const { type, slug, expected } of testCases) {
				const field = await registry.createField("posts", {
					slug,
					label: type,
					type,
				});
				expect(field.columnType).toBe(expected);
			}
		});

		it("should reorder fields", async () => {
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			await registry.createField("posts", {
				slug: "content",
				label: "Content",
				type: "portableText",
			});
			await registry.createField("posts", {
				slug: "author",
				label: "Author",
				type: "reference",
			});

			await registry.reorderFields("posts", ["author", "title", "content"]);

			const collection = await registry.getCollection("posts");
			const fields = await registry.listFields(collection!.id);

			expect(fields[0].slug).toBe("author");
			expect(fields[1].slug).toBe("title");
			expect(fields[2].slug).toBe("content");
		});
	});

	describe("Collection with Fields", () => {
		it("should get collection with all fields", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			await registry.createField("posts", {
				slug: "content",
				label: "Content",
				type: "portableText",
			});

			const collection = await registry.getCollectionWithFields("posts");

			expect(collection).not.toBeNull();
			expect(collection?.slug).toBe("posts");
			expect(collection?.fields).toHaveLength(2);
			expect(collection?.fields[0].slug).toBe("title");
			expect(collection?.fields[1].slug).toBe("content");
		});

		it("should cascade delete fields when deleting collection", async () => {
			await registry.createCollection({ slug: "temp", label: "Temp" });
			await registry.createField("temp", {
				slug: "field1",
				label: "Field 1",
				type: "string",
			});

			await registry.deleteCollection("temp");

			// Fields should be gone (cascade delete)
			const field = await registry.getField("temp", "field1");
			expect(field).toBeNull();
		});
	});

	describe("Search (FTS) Integration", () => {
		let ftsManager: FTSManager;

		beforeEach(() => {
			ftsManager = new FTSManager(db);
		});

		it("creates FTS table when adding a searchable field to a collection with search support", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});

			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});

			expect(await ftsManager.ftsTableExists("articles")).toBe(true);
		});

		it("creates FTS table when adding search support to a collection that already has searchable fields", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["drafts"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});

			// FTS should not exist before enabling search
			expect(await ftsManager.ftsTableExists("articles")).toBe(false);

			await registry.updateCollection("articles", { supports: ["drafts", "search"] });

			expect(await ftsManager.ftsTableExists("articles")).toBe(true);
		});

		it("disables FTS when search support is removed from a collection", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});
			// createField auto-syncs; verify FTS is live before testing the disable path
			expect(await ftsManager.ftsTableExists("articles")).toBe(true);

			await registry.updateCollection("articles", { supports: ["drafts"] });

			expect(await ftsManager.ftsTableExists("articles")).toBe(false);
		});

		it("rebuilds FTS table to include a new searchable field when collection already has search enabled", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});
			// createField auto-syncs; verify FTS is live before adding the second field
			expect(await ftsManager.ftsTableExists("articles")).toBe(true);

			// Add a second searchable field — FTS table must be rebuilt to include it
			await registry.createField("articles", {
				slug: "body",
				label: "Body",
				type: "text",
				searchable: true,
			});

			// Verify the FTS table was rebuilt to include the body column.
			// Selecting a non-existent column from the FTS virtual table throws an error.
			await expect(
				sql`SELECT body FROM "_emdash_fts_articles" LIMIT 0`.execute(db),
			).resolves.toBeDefined();
		});

		it("deletes a searchable field from a search-enabled collection without error", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});
			await registry.createField("articles", {
				slug: "body",
				label: "Body",
				type: "text",
				searchable: true,
			});
			// FTS is now active with title and body columns in its triggers

			// Deleting a searchable field must not throw (SQLite rejects dropping a
			// column still referenced by a trigger)
			await expect(registry.deleteField("articles", "body")).resolves.toBeUndefined();

			// FTS should be rebuilt around the remaining searchable field
			expect(await ftsManager.ftsTableExists("articles")).toBe(true);
			await expect(
				sql`SELECT title FROM "_emdash_fts_articles" LIMIT 0`.execute(db),
			).resolves.toBeDefined();
		});

		it("drops FTS table when deleting a search-enabled collection", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});
			// createField auto-syncs; verify FTS is live before testing collection deletion
			expect(await ftsManager.ftsTableExists("articles")).toBe(true);

			await registry.deleteCollection("articles");

			expect(await ftsManager.ftsTableExists("articles")).toBe(false);
		});

		it("disables FTS when the last searchable field is deleted", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});
			expect(await ftsManager.ftsTableExists("articles")).toBe(true);

			await registry.deleteField("articles", "title");

			expect(await ftsManager.ftsTableExists("articles")).toBe(false);
		});

		it("does not create FTS table when collection supports search but has no searchable fields", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: false,
			});

			expect(await ftsManager.ftsTableExists("articles")).toBe(false);
		});

		it("preserves weights when search support is toggled off then back on", async () => {
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				supports: ["search"],
			});
			await registry.createField("articles", {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});

			// Enable FTS with custom weights
			await ftsManager.enableSearch("articles", { weights: { title: 10 } });
			const initialConfig = await ftsManager.getSearchConfig("articles");
			expect(initialConfig?.weights).toEqual({ title: 10 });

			// Toggle search support off — drops FTS table, must preserve weights in config
			await registry.updateCollection("articles", { supports: ["drafts"] });
			expect(await ftsManager.ftsTableExists("articles")).toBe(false);

			// Toggle search support back on — must re-enable with the preserved weights
			await registry.updateCollection("articles", { supports: ["drafts", "search"] });
			expect(await ftsManager.ftsTableExists("articles")).toBe(true);

			const finalConfig = await ftsManager.getSearchConfig("articles");
			expect(finalConfig?.weights).toEqual({ title: 10 });
		});
	});
});
