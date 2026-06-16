import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

		it("F14: defaults supports to ['drafts', 'revisions'] when undefined", async () => {
			const collection = await registry.createCollection({
				slug: "default_supports",
				label: "Default Supports",
				// supports omitted entirely
			});

			expect(collection.supports.toSorted()).toEqual(["drafts", "revisions"].toSorted());
		});

		it("F14: preserves explicit empty supports array (opt-out)", async () => {
			const collection = await registry.createCollection({
				slug: "no_supports",
				label: "No Supports",
				supports: [],
			});

			expect(collection.supports).toEqual([]);
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

		it("should clean up associated data when deleting a collection", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			// Insert a content row
			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group) VALUES ('p1', 'test', 'published', 'en', 'tg1')`.execute(
				db,
			);

			// Insert associated data across all 5 tables
			await sql`INSERT INTO revisions (id, collection, entry_id, data) VALUES ('r1', 'posts', 'p1', '{}')`.execute(
				db,
			);
			await sql`INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id) VALUES ('posts', 'p1', 'tax1')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_comments (id, collection, content_id, author_name, author_email, body, status) VALUES ('c1', 'posts', 'p1', 'Test', 'test@test.com', 'hi', 'approved')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_seo (collection, content_id) VALUES ('posts', 'p1')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_content_bylines (id, collection_slug, content_id, byline_id, sort_order) VALUES ('b1', 'posts', 'p1', 'by1', 0)`.execute(
				db,
			);

			await registry.deleteCollection("posts", { force: true });

			// All 5 tables should be clean
			const revisions = await sql`SELECT * FROM revisions WHERE collection = 'posts'`.execute(db);
			expect(revisions.rows.length).toBe(0);

			const taxonomies =
				await sql`SELECT * FROM content_taxonomies WHERE collection = 'posts'`.execute(db);
			expect(taxonomies.rows.length).toBe(0);

			const comments = await sql`SELECT * FROM _emdash_comments WHERE collection = 'posts'`.execute(
				db,
			);
			expect(comments.rows.length).toBe(0);

			const seo = await sql`SELECT * FROM _emdash_seo WHERE collection = 'posts'`.execute(db);
			expect(seo.rows.length).toBe(0);

			const bylines =
				await sql`SELECT * FROM _emdash_content_bylines WHERE collection_slug = 'posts'`.execute(
					db,
				);
			expect(bylines.rows.length).toBe(0);
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

		it("should reject built-in column names as field slugs", async () => {
			await expect(
				registry.createField("posts", {
					slug: "locale",
					label: "Locale",
					type: "string",
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "translation_group",
					label: "Translation Group",
					type: "string",
				}),
			).rejects.toThrow(SchemaError);
		});

		it("should reject field slugs that collide with built-in index names", async () => {
			await expect(
				registry.createField("posts", {
					slug: "author",
					label: "Author",
					type: "string",
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "scheduled",
					label: "Scheduled",
					type: "string",
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "deleted_status",
					label: "Deleted Status",
					type: "string",
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "loc_upd",
					label: "Loc Upd",
					type: "string",
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "loc_crt",
					label: "Loc Crt",
					type: "string",
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
				slug: "writer",
				label: "Writer",
				type: "reference",
			});

			await registry.reorderFields("posts", ["writer", "title", "content"]);

			const collection = await registry.getCollection("posts");
			const fields = await registry.listFields(collection!.id);

			expect(fields[0].slug).toBe("writer");
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

		it("does not auto-enable FTS when adding a searchable field", async () => {
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

			expect(await ftsManager.ftsTableExists("articles")).toBe(false);
		});

		it("does not auto-enable FTS when adding search support to a collection", async () => {
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

			expect(await ftsManager.ftsTableExists("articles")).toBe(false);

			await registry.updateCollection("articles", { supports: ["drafts", "search"] });

			expect(await ftsManager.ftsTableExists("articles")).toBe(false);
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
			await ftsManager.enableSearch("articles");
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
			await ftsManager.enableSearch("articles");
			expect(await ftsManager.ftsTableExists("articles")).toBe(true);

			await registry.createField("articles", {
				slug: "body",
				label: "Body",
				type: "text",
				searchable: true,
			});

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
			await ftsManager.enableSearch("articles");

			await expect(registry.deleteField("articles", "body")).resolves.toBeUndefined();

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
			await ftsManager.enableSearch("articles");
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
			await ftsManager.enableSearch("articles");
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

		it("preserves weights in config when search support is toggled off", async () => {
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

			await ftsManager.enableSearch("articles", { weights: { title: 10 } });
			const initialConfig = await ftsManager.getSearchConfig("articles");
			expect(initialConfig?.weights).toEqual({ title: 10 });

			await registry.updateCollection("articles", { supports: ["drafts"] });
			expect(await ftsManager.ftsTableExists("articles")).toBe(false);

			const finalConfig = await ftsManager.getSearchConfig("articles");
			expect(finalConfig?.weights).toEqual({ title: 10 });
		});
	});

	describe("atomicity: rollback on FTS sync failure", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("rolls back updateCollection when FTS disable fails", async () => {
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
			const ftsManager = new FTSManager(db);
			await ftsManager.enableSearch("articles");

			vi.spyOn(FTSManager.prototype, "disableSearch").mockRejectedValueOnce(
				new Error("FTS sync sabotaged"),
			);

			await expect(
				registry.updateCollection("articles", { supports: ["drafts"] }),
			).rejects.toThrow();

			const collection = await registry.getCollection("articles");
			expect(collection?.supports).toContain("search");
		});

		it("rolls back updateField when FTS rebuild fails", async () => {
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
			const ftsManager = new FTSManager(db);
			await ftsManager.enableSearch("articles");

			vi.spyOn(FTSManager.prototype, "disableSearch").mockRejectedValueOnce(
				new Error("FTS sync sabotaged"),
			);

			await expect(
				registry.updateField("articles", "title", { searchable: false }),
			).rejects.toThrow();

			const field = await registry.getField("articles", "title");
			expect(field?.searchable).toBe(true);
		});

		it("rolls back deleteField when FTS rebuild fails", async () => {
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
			const ftsManager = new FTSManager(db);
			await ftsManager.enableSearch("articles");

			vi.spyOn(FTSManager.prototype, "rebuildIndex").mockRejectedValueOnce(
				new Error("FTS sync sabotaged"),
			);

			await expect(registry.deleteField("articles", "body")).rejects.toThrow();

			const field = await registry.getField("articles", "body");
			expect(field).not.toBeNull();
		});

		it("rolls back createField when FTS rebuild fails", async () => {
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
			const ftsManager = new FTSManager(db);
			await ftsManager.enableSearch("articles");

			vi.spyOn(FTSManager.prototype, "rebuildIndex").mockRejectedValueOnce(
				new Error("FTS sync sabotaged"),
			);

			await expect(
				registry.createField("articles", {
					slug: "body",
					label: "Body",
					type: "text",
					searchable: true,
				}),
			).rejects.toThrow();

			const field = await registry.getField("articles", "body");
			expect(field).toBeNull();
		});
	});

	describe("Required Constraint Sync", () => {
		beforeEach(async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });
		});

		it("should backfill NULL rows when required changes false→true", async () => {
			await registry.createField("posts", {
				slug: "subtitle",
				label: "Subtitle",
				type: "string",
			});

			// Insert rows with NULL subtitle
			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group) VALUES ('1', 'a', 'draft', 'en', 'tg1')`.execute(
				db,
			);
			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group) VALUES ('2', 'b', 'draft', 'en', 'tg2')`.execute(
				db,
			);

			// Verify NULLs
			const before = await sql<{
				subtitle: string | null;
			}>`SELECT subtitle FROM ec_posts ORDER BY id`.execute(db);
			expect(before.rows[0]!.subtitle).toBeNull();
			expect(before.rows[1]!.subtitle).toBeNull();

			await registry.updateField("posts", "subtitle", { required: true });

			const after = await sql<{
				subtitle: string;
			}>`SELECT subtitle FROM ec_posts ORDER BY id`.execute(db);
			expect(after.rows[0]!.subtitle).toBe("");
			expect(after.rows[1]!.subtitle).toBe("");
		});

		it("should backfill with defaultValue when provided", async () => {
			await registry.createField("posts", {
				slug: "priority",
				label: "Priority",
				type: "integer",
			});

			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group) VALUES ('1', 'a', 'draft', 'en', 'tg1')`.execute(
				db,
			);

			await registry.updateField("posts", "priority", {
				required: true,
				defaultValue: 5,
			});

			const after = await sql<{ priority: number }>`SELECT priority FROM ec_posts`.execute(db);
			expect(after.rows[0]!.priority).toBe(5);
		});

		it("should backfill with field's existing defaultValue", async () => {
			await registry.createField("posts", {
				slug: "category",
				label: "Category",
				type: "string",
				defaultValue: "general",
			});

			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group, category) VALUES ('1', 'a', 'draft', 'en', 'tg1', NULL)`.execute(
				db,
			);

			await registry.updateField("posts", "category", { required: true });

			const after = await sql<{
				category: string;
			}>`SELECT category FROM ec_posts`.execute(db);
			expect(after.rows[0]!.category).toBe("general");
		});

		it("should not change non-null rows during backfill", async () => {
			await registry.createField("posts", {
				slug: "subtitle",
				label: "Subtitle",
				type: "string",
			});

			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group, subtitle) VALUES ('1', 'a', 'draft', 'en', 'tg1', 'existing')`.execute(
				db,
			);
			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group) VALUES ('2', 'b', 'draft', 'en', 'tg2')`.execute(
				db,
			);

			await registry.updateField("posts", "subtitle", { required: true });

			const after = await sql<{
				subtitle: string;
			}>`SELECT subtitle FROM ec_posts ORDER BY id`.execute(db);
			expect(after.rows[0]!.subtitle).toBe("existing");
			expect(after.rows[1]!.subtitle).toBe("");
		});

		it("should backfill numeric types with 0", async () => {
			await registry.createField("posts", {
				slug: "views",
				label: "Views",
				type: "integer",
			});

			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group) VALUES ('1', 'a', 'draft', 'en', 'tg1')`.execute(
				db,
			);

			await registry.updateField("posts", "views", { required: true });

			const after = await sql<{ views: number }>`SELECT views FROM ec_posts`.execute(db);
			expect(after.rows[0]!.views).toBe(0);
		});

		it("should allow required true→false without error on SQLite", async () => {
			await registry.createField("posts", {
				slug: "subtitle",
				label: "Subtitle",
				type: "string",
				required: true,
			});

			const updated = await registry.updateField("posts", "subtitle", {
				required: false,
			});

			expect(updated.required).toBe(false);
		});

		it("should update metadata when required changes", async () => {
			await registry.createField("posts", {
				slug: "subtitle",
				label: "Subtitle",
				type: "string",
			});

			const updated = await registry.updateField("posts", "subtitle", {
				required: true,
			});
			expect(updated.required).toBe(true);

			const reverted = await registry.updateField("posts", "subtitle", {
				required: false,
			});
			expect(reverted.required).toBe(false);
		});

		it("should reject making unique field required when multiple NULLs exist", async () => {
			await registry.createField("posts", {
				slug: "code",
				label: "Code",
				type: "string",
				unique: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group)
				VALUES ('id1', 'p1', 'published', 'en', 'tg1')`.execute(db);
			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group)
				VALUES ('id2', 'p2', 'published', 'en', 'tg2')`.execute(db);

			await expect(registry.updateField("posts", "code", { required: true })).rejects.toThrow(
				"multiple NULL values exist",
			);
		});

		it("should allow making unique field required when only one NULL exists", async () => {
			await registry.createField("posts", {
				slug: "code",
				label: "Code",
				type: "string",
				unique: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, locale, translation_group)
				VALUES ('id1', 'p1', 'published', 'en', 'tg1')`.execute(db);

			const updated = await registry.updateField("posts", "code", { required: true });
			expect(updated.required).toBe(true);
		});
	});

	describe("Unique Constraints", () => {
		beforeEach(async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });
		});

		it("should create a unique index when unique is true", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name LIKE '%email_unique%'
			`.execute(db);
			expect(indexes.rows.length).toBe(1);
		});

		it("should reject unique on JSON field types", async () => {
			await expect(
				registry.createField("posts", {
					slug: "tags",
					label: "Tags",
					type: "multiSelect",
					unique: true,
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "body",
					label: "Body",
					type: "portableText",
					unique: true,
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "meta",
					label: "Meta",
					type: "json",
					unique: true,
				}),
			).rejects.toThrow(SchemaError);
		});

		it("should reject unique on image and file types", async () => {
			await expect(
				registry.createField("posts", {
					slug: "photo",
					label: "Photo",
					type: "image",
					unique: true,
				}),
			).rejects.toThrow(SchemaError);

			await expect(
				registry.createField("posts", {
					slug: "attachment",
					label: "Attachment",
					type: "file",
					unique: true,
				}),
			).rejects.toThrow(SchemaError);
		});

		it("should reject unique + non-translatable combination", async () => {
			await expect(
				registry.createField("posts", {
					slug: "code",
					label: "Code",
					type: "string",
					unique: true,
					translatable: false,
				}),
			).rejects.toThrow(SchemaError);
		});

		it("should enforce unique constraint — reject duplicate values same locale", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id1', 'post-1', 'published', 'a@b.com', 'en')`.execute(db);

			await expect(
				sql`INSERT INTO ec_posts (id, slug, status, email, locale)
					VALUES ('id2', 'post-2', 'published', 'a@b.com', 'en')`.execute(db),
			).rejects.toThrow();
		});

		it("should enforce unique constraint on required=true field (no NULL guard)", async () => {
			await registry.createField("posts", {
				slug: "code",
				label: "Code",
				type: "string",
				unique: true,
				required: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, code, locale)
				VALUES ('id1', 'post-1', 'published', 'ABC', 'en')`.execute(db);

			await expect(
				sql`INSERT INTO ec_posts (id, slug, status, code, locale)
					VALUES ('id2', 'post-2', 'published', 'ABC', 'en')`.execute(db),
			).rejects.toThrow();
		});

		it("should enforce unique constraint across different statuses", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id1', 'post-1', 'draft', 'a@b.com', 'en')`.execute(db);

			await expect(
				sql`INSERT INTO ec_posts (id, slug, status, email, locale)
					VALUES ('id2', 'post-2', 'published', 'a@b.com', 'en')`.execute(db),
			).rejects.toThrow();
		});

		it("should enforce unique constraint on restore when draft exists with same value", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			// Insert published article, then soft-delete it
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id1', 'post-1', 'published', 'a@b.com', 'en')`.execute(db);
			await sql`UPDATE ec_posts SET deleted_at = '2024-01-01' WHERE id = 'id1'`.execute(db);

			// Insert a draft with the same email
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id2', 'post-2', 'draft', 'a@b.com', 'en')`.execute(db);

			// Restore should fail — draft occupies the unique slot
			await expect(
				sql`UPDATE ec_posts SET deleted_at = NULL WHERE id = 'id1'`.execute(db),
			).rejects.toThrow();
		});

		it("should allow same value in different locales", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id1', 'post-1', 'published', 'a@b.com', 'en')`.execute(db);

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id2', 'post-2', 'published', 'a@b.com', 'fr')`.execute(db);

			const rows = await sql`SELECT id FROM ec_posts WHERE email = 'a@b.com'`.execute(db);
			expect(rows.rows.length).toBe(2);
		});

		it("should allow multiple NULL values in unique field", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id1', 'post-1', 'published', NULL, 'en')`.execute(db);
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id2', 'post-2', 'published', NULL, 'en')`.execute(db);

			const rows = await sql`SELECT id FROM ec_posts WHERE email IS NULL`.execute(db);
			expect(rows.rows.length).toBe(2);
		});

		it("should exclude soft-deleted rows from unique constraint", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale, deleted_at)
				VALUES ('id1', 'post-1', 'published', 'a@b.com', 'en', '2024-01-01')`.execute(db);

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id2', 'post-2', 'published', 'a@b.com', 'en')`.execute(db);

			const rows = await sql`SELECT id FROM ec_posts WHERE email = 'a@b.com'`.execute(db);
			expect(rows.rows.length).toBe(2);
		});

		it("should create unique index on updateField unique false→true", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
			});

			await registry.updateField("posts", "email", { unique: true });

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name LIKE '%email_unique%'
			`.execute(db);
			expect(indexes.rows.length).toBe(1);
		});

		it("should drop unique index on updateField unique true→false", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await registry.updateField("posts", "email", { unique: false });

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name LIKE '%email_unique%'
			`.execute(db);
			expect(indexes.rows.length).toBe(0);
		});

		it("should reject updateField unique=true when duplicates exist", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
			});

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id1', 'post-1', 'published', 'a@b.com', 'en')`.execute(db);
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id2', 'post-2', 'published', 'a@b.com', 'en')`.execute(db);

			await expect(registry.updateField("posts", "email", { unique: true })).rejects.toThrow(
				SchemaError,
			);
		});

		it("should reject update setting unique=true + translatable=false", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await expect(registry.updateField("posts", "email", { translatable: false })).rejects.toThrow(
				SchemaError,
			);
		});

		it("should clean up unique index on deleteField", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			await registry.deleteField("posts", "email");

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_email_unique'
			`.execute(db);
			expect(indexes.rows.length).toBe(0);
		});

		it("should rebuild unique index when required changes on a unique field", async () => {
			await registry.createField("posts", {
				slug: "email",
				label: "Email",
				type: "string",
				unique: true,
			});

			// Non-required unique: multiple NULLs allowed
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id1', 'post-1', 'published', NULL, 'en')`.execute(db);
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id2', 'post-2', 'published', NULL, 'en')`.execute(db);

			const rows = await sql`SELECT id FROM ec_posts WHERE email IS NULL`.execute(db);
			expect(rows.rows.length).toBe(2);

			// Clean up for the required=true transition
			await sql`DELETE FROM ec_posts WHERE id = 'id2'`.execute(db);

			await registry.updateField("posts", "email", { required: true });

			// Required unique: NULLs are backfilled — duplicate non-null values rejected
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id3', 'post-3', 'published', 'x@test.com', 'en')`.execute(db);
			await expect(
				sql`INSERT INTO ec_posts (id, slug, status, email, locale)
					VALUES ('id4', 'post-4', 'published', 'x@test.com', 'en')`.execute(db),
			).rejects.toThrow();

			// Switch back to non-required: multiple NULLs should be allowed again
			await registry.updateField("posts", "email", { required: false });

			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id5', 'post-5', 'published', NULL, 'en')`.execute(db);
			await sql`INSERT INTO ec_posts (id, slug, status, email, locale)
				VALUES ('id6', 'post-6', 'published', NULL, 'en')`.execute(db);

			const nullRows = await sql`SELECT id FROM ec_posts WHERE email IS NULL`.execute(db);
			expect(nullRows.rows.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("Indexed Fields", () => {
		beforeEach(async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });
		});

		it("should create a plain index when indexed is true", async () => {
			const field = await registry.createField("posts", {
				slug: "series",
				label: "Series",
				type: "string",
				indexed: true,
			});

			expect(field.indexed).toBe(true);

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_series'
			`.execute(db);
			expect(indexes.rows.length).toBe(1);
		});

		it("should reject indexed on JSON field types", async () => {
			await expect(
				registry.createField("posts", {
					slug: "tags",
					label: "Tags",
					type: "multiSelect",
					indexed: true,
				}),
			).rejects.toThrow("does not support indexes");

			await expect(
				registry.createField("posts", {
					slug: "body",
					label: "Body",
					type: "portableText",
					indexed: true,
				}),
			).rejects.toThrow("does not support indexes");

			await expect(
				registry.createField("posts", {
					slug: "meta",
					label: "Meta",
					type: "json",
					indexed: true,
				}),
			).rejects.toThrow("does not support indexes");
		});

		it("should reject indexed on image and file types", async () => {
			await expect(
				registry.createField("posts", {
					slug: "photo",
					label: "Photo",
					type: "image",
					indexed: true,
				}),
			).rejects.toThrow("does not support indexes");

			await expect(
				registry.createField("posts", {
					slug: "attachment",
					label: "Attachment",
					type: "file",
					indexed: true,
				}),
			).rejects.toThrow("does not support indexes");
		});

		it("should reject indexed on repeater type", async () => {
			await expect(
				registry.createField("posts", {
					slug: "items",
					label: "Items",
					type: "repeater",
					indexed: true,
				}),
			).rejects.toThrow("does not support indexes");
		});

		it("should default indexed to false when not specified", async () => {
			const field = await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			expect(field.indexed).toBe(false);
		});

		it("should allow indexed on reference type", async () => {
			const field = await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				indexed: true,
			});
			expect(field.indexed).toBe(true);
		});

		it("should reject updateField indexed=true on non-indexable type", async () => {
			await registry.createField("posts", {
				slug: "tags",
				label: "Tags",
				type: "multiSelect",
			});

			await expect(registry.updateField("posts", "tags", { indexed: true })).rejects.toThrow(
				"does not support indexes",
			);
		});

		it("should create plain index on updateField indexed false→true", async () => {
			await registry.createField("posts", {
				slug: "series",
				label: "Series",
				type: "string",
			});

			await registry.updateField("posts", "series", { indexed: true });

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_series'
			`.execute(db);
			expect(indexes.rows.length).toBe(1);
		});

		it("should drop plain index on updateField indexed true→false", async () => {
			await registry.createField("posts", {
				slug: "series",
				label: "Series",
				type: "string",
				indexed: true,
			});

			await registry.updateField("posts", "series", { indexed: false });

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_series'
			`.execute(db);
			expect(indexes.rows.length).toBe(0);
		});

		it("should switch from plain index to unique index", async () => {
			await registry.createField("posts", {
				slug: "code",
				label: "Code",
				type: "string",
				indexed: true,
			});

			await registry.updateField("posts", "code", { unique: true });

			const plain = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_code'
			`.execute(db);
			expect(plain.rows.length).toBe(0);

			const unique = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_code_unique'
			`.execute(db);
			expect(unique.rows.length).toBe(1);
		});

		it("should switch from unique index to plain index", async () => {
			await registry.createField("posts", {
				slug: "code",
				label: "Code",
				type: "string",
				unique: true,
			});

			await registry.updateField("posts", "code", { unique: false, indexed: true });

			const unique = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_code_unique'
			`.execute(db);
			expect(unique.rows.length).toBe(0);

			const plain = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_code'
			`.execute(db);
			expect(plain.rows.length).toBe(1);
		});

		it("should allow duplicate values after switching from unique to plain index", async () => {
			await registry.createField("posts", {
				slug: "code",
				label: "Code",
				type: "string",
				unique: true,
			});

			await registry.updateField("posts", "code", { unique: false, indexed: true });

			await sql`INSERT INTO ec_posts (id, slug, status, code, locale)
				VALUES ('id1', 'post-1', 'published', 'SAME', 'en')`.execute(db);
			await sql`INSERT INTO ec_posts (id, slug, status, code, locale)
				VALUES ('id2', 'post-2', 'published', 'SAME', 'en')`.execute(db);

			const rows = await sql`SELECT id FROM ec_posts WHERE code = 'SAME'`.execute(db);
			expect(rows.rows.length).toBe(2);
		});

		it("should only create unique index when both unique and indexed are true", async () => {
			const field = await registry.createField("posts", {
				slug: "sku",
				label: "SKU",
				type: "string",
				unique: true,
				indexed: true,
			});

			expect(field.unique).toBe(true);
			expect(field.indexed).toBe(true);

			const plain = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_sku'
			`.execute(db);
			expect(plain.rows.length).toBe(0);

			const unique = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_sku_unique'
			`.execute(db);
			expect(unique.rows.length).toBe(1);
		});

		it("should clean up plain index on deleteField", async () => {
			await registry.createField("posts", {
				slug: "series",
				label: "Series",
				type: "string",
				indexed: true,
			});

			await registry.deleteField("posts", "series");

			const indexes = await sql`
				SELECT name FROM sqlite_master
				WHERE type = 'index' AND name = 'idx_ec_posts_series'
			`.execute(db);
			expect(indexes.rows.length).toBe(0);
		});
	});
});
