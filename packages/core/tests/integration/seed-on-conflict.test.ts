/**
 * Tests for seed --on-conflict modes: skip, update, error
 *
 * Verifies that applySeed() correctly handles conflicts when records
 * already exist in the database.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

/**
 * Minimal seed file with one collection, one byline, one redirect, and one section
 */
function createTestSeed(overrides?: Partial<SeedFile>): SeedFile {
	return {
		version: "1",
		collections: [
			{
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
				fields: [
					{ slug: "title", label: "Title", type: "string" },
					{ slug: "body", label: "Body", type: "text" },
				],
			},
		],
		bylines: [
			{
				id: "byline-1",
				slug: "jane-doe",
				displayName: "Jane Doe",
				bio: "Original bio",
			},
		],
		redirects: [
			{
				source: "/old-page",
				destination: "/new-page",
				type: 301,
			},
		],
		sections: [
			{
				slug: "hero",
				title: "Hero Section",
				description: "Original description",
				content: [{ _type: "block", _key: "1" }],
			},
		],
		content: {
			posts: [
				{
					id: "post-1",
					slug: "hello-world",
					status: "published",
					data: { title: "Hello World", body: "Original body" },
				},
			],
		},
		...overrides,
	};
}

/**
 * Seed file with updated values for all entities
 */
function createUpdatedSeed(): SeedFile {
	return {
		version: "1",
		collections: [
			{
				slug: "posts",
				label: "Blog Posts",
				labelSingular: "Blog Post",
				fields: [
					{ slug: "title", label: "Post Title", type: "string" },
					{ slug: "body", label: "Post Body", type: "text" },
				],
			},
		],
		bylines: [
			{
				id: "byline-1",
				slug: "jane-doe",
				displayName: "Jane Smith",
				bio: "Updated bio",
			},
		],
		redirects: [
			{
				source: "/old-page",
				destination: "/newer-page",
				type: 302,
			},
		],
		sections: [
			{
				slug: "hero",
				title: "Updated Hero",
				description: "Updated description",
				content: [{ _type: "block", _key: "2" }],
			},
		],
		content: {
			posts: [
				{
					id: "post-1",
					slug: "hello-world",
					status: "published",
					data: { title: "Hello World Updated", body: "Updated body" },
				},
			],
		},
	};
}

describe("applySeed onConflict modes", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("onConflict: skip (default)", () => {
		it("skips existing collections", async () => {
			const seed = createTestSeed();
			// First apply
			await applySeed(db, seed, { includeContent: true });
			// Second apply with default (skip)
			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.collections.created).toBe(0);
			expect(result.collections.skipped).toBe(1);
			expect(result.collections.updated).toBe(0);
		});

		it("skips existing bylines", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });
			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.bylines.created).toBe(0);
			expect(result.bylines.skipped).toBe(1);
			expect(result.bylines.updated).toBe(0);
		});

		it("skips existing redirects", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed);
			const result = await applySeed(db, seed);

			expect(result.redirects.created).toBe(0);
			expect(result.redirects.skipped).toBe(1);
			expect(result.redirects.updated).toBe(0);
		});

		it("skips existing sections", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed);
			const result = await applySeed(db, seed);

			expect(result.sections.created).toBe(0);
			expect(result.sections.skipped).toBe(1);
			expect(result.sections.updated).toBe(0);
		});

		it("skips existing content", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });
			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.content.created).toBe(0);
			expect(result.content.skipped).toBe(1);
			expect(result.content.updated).toBe(0);
		});

		it("defaults to skip when onConflict is not specified", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });
			// No onConflict specified -- should default to skip
			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.collections.skipped).toBe(1);
			expect(result.collections.created).toBe(0);
			expect(result.collections.updated).toBe(0);
		});
	});

	describe("onConflict: update", () => {
		it("updates existing collections and fields", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });

			const updatedSeed = createUpdatedSeed();
			const result = await applySeed(db, updatedSeed, {
				includeContent: true,
				onConflict: "update",
			});

			expect(result.collections.updated).toBe(1);
			expect(result.collections.created).toBe(0);
			expect(result.fields.updated).toBe(2);

			// Verify the collection was actually updated
			const row = await db
				.selectFrom("_emdash_collections")
				.selectAll()
				.where("slug", "=", "posts")
				.executeTakeFirst();
			expect(row?.label).toBe("Blog Posts");
			expect(row?.label_singular).toBe("Blog Post");
		});

		it("applies a same-affinity field type change (#1397)", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });

			// title: string (TEXT) -> slug (TEXT). Same column affinity, so the
			// type change persists rather than being silently dropped.
			const changed = createTestSeed();
			changed.collections![0]!.fields![0]!.type = "slug";

			const result = await applySeed(db, changed, {
				includeContent: true,
				onConflict: "update",
			});
			expect(result.fields.updated).toBe(2);

			const row = await db
				.selectFrom("_emdash_fields")
				.innerJoin(
					"_emdash_collections",
					"_emdash_collections.id",
					"_emdash_fields.collection_id",
				)
				.select(["_emdash_fields.type as type", "_emdash_fields.column_type as columnType"])
				.where("_emdash_collections.slug", "=", "posts")
				.where("_emdash_fields.slug", "=", "title")
				.executeTakeFirst();
			expect(row?.type).toBe("slug");
			expect(row?.columnType).toBe("TEXT");
		});

		it("rejects an affinity-changing field type change instead of silently dropping it (#1397)", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });

			// body: text (TEXT) -> portableText (JSON) changes the physical column
			// type. Re-seeding must fail loudly rather than report success while
			// leaving _emdash_fields.type/column_type stale.
			const changed = createTestSeed();
			changed.collections![0]!.fields![1]!.type = "portableText";

			await expect(
				applySeed(db, changed, { includeContent: true, onConflict: "update" }),
			).rejects.toThrow(/column type/i);

			// Stored metadata is untouched (no silent rewrite).
			const row = await db
				.selectFrom("_emdash_fields")
				.innerJoin(
					"_emdash_collections",
					"_emdash_collections.id",
					"_emdash_fields.collection_id",
				)
				.select(["_emdash_fields.type as type", "_emdash_fields.column_type as columnType"])
				.where("_emdash_collections.slug", "=", "posts")
				.where("_emdash_fields.slug", "=", "body")
				.executeTakeFirst();
			expect(row?.type).toBe("text");
			expect(row?.columnType).toBe("TEXT");
		});

		it("updates existing bylines", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });

			const updatedSeed = createUpdatedSeed();
			const result = await applySeed(db, updatedSeed, {
				includeContent: true,
				onConflict: "update",
			});

			expect(result.bylines.updated).toBe(1);
			expect(result.bylines.created).toBe(0);

			// Verify the byline was actually updated
			const row = await db
				.selectFrom("_emdash_bylines")
				.selectAll()
				.where("slug", "=", "jane-doe")
				.executeTakeFirst();
			expect(row?.display_name).toBe("Jane Smith");
			expect(row?.bio).toBe("Updated bio");
		});

		it("updates existing redirects", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed);

			const updatedSeed = createUpdatedSeed();
			const result = await applySeed(db, updatedSeed, {
				onConflict: "update",
			});

			expect(result.redirects.updated).toBe(1);
			expect(result.redirects.created).toBe(0);

			// Verify the redirect was actually updated
			const row = await db
				.selectFrom("_emdash_redirects")
				.selectAll()
				.where("source", "=", "/old-page")
				.executeTakeFirst();
			expect(row?.destination).toBe("/newer-page");
			expect(row?.type).toBe(302);
		});

		it("updates existing sections", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed);

			const updatedSeed = createUpdatedSeed();
			const result = await applySeed(db, updatedSeed, {
				onConflict: "update",
			});

			expect(result.sections.updated).toBe(1);
			expect(result.sections.created).toBe(0);

			// Verify the section was actually updated
			const row = await db
				.selectFrom("_emdash_sections")
				.selectAll()
				.where("slug", "=", "hero")
				.executeTakeFirst();
			expect(row?.title).toBe("Updated Hero");
			expect(row?.description).toBe("Updated description");
		});

		it("updates existing content", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });

			const updatedSeed = createUpdatedSeed();
			const result = await applySeed(db, updatedSeed, {
				includeContent: true,
				onConflict: "update",
			});

			expect(result.content.updated).toBe(1);
			expect(result.content.created).toBe(0);

			// Verify the content was actually updated
			const row = await db
				.selectFrom("ec_posts" as any)
				.selectAll()
				.where("slug", "=", "hello-world")
				.executeTakeFirstOrThrow();
			expect((row as Record<string, unknown>).title).toBe("Hello World Updated");
			expect((row as Record<string, unknown>).body).toBe("Updated body");
		});
	});

	describe("onConflict: error", () => {
		it("throws on existing collection", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });

			await expect(
				applySeed(db, seed, {
					includeContent: true,
					onConflict: "error",
				}),
			).rejects.toThrow('Conflict: collection "posts" already exists');
		});

		it("throws on existing byline", async () => {
			// Seed without collections to get past collections step
			const seed = createTestSeed({ collections: [] });
			await applySeed(db, seed);

			await expect(applySeed(db, seed, { onConflict: "error" })).rejects.toThrow(
				'Conflict: byline "jane-doe" already exists',
			);
		});

		it("throws on existing redirect", async () => {
			const seed = createTestSeed({
				collections: [],
				bylines: [],
				sections: [],
			});
			await applySeed(db, seed);

			await expect(applySeed(db, seed, { onConflict: "error" })).rejects.toThrow(
				'Conflict: redirect "/old-page" already exists',
			);
		});

		it("throws on existing section", async () => {
			const seed = createTestSeed({
				collections: [],
				bylines: [],
				redirects: [],
			});
			await applySeed(db, seed);

			await expect(applySeed(db, seed, { onConflict: "error" })).rejects.toThrow(
				'Conflict: section "hero" already exists',
			);
		});

		it("throws on existing content", async () => {
			// First apply creates collections and content
			const seed = createTestSeed({
				bylines: [],
				redirects: [],
				sections: [],
			});
			await applySeed(db, seed, { includeContent: true });

			// Second apply with only content (collections already exist, skip them)
			const contentOnlySeed = createTestSeed({
				collections: [],
				bylines: [],
				redirects: [],
				sections: [],
			});
			await expect(
				applySeed(db, contentOnlySeed, {
					includeContent: true,
					onConflict: "error",
				}),
			).rejects.toThrow('Conflict: content "hello-world" in "posts" already exists');
		});
	});

	describe("mixed scenarios", () => {
		it("creates new records alongside existing ones in update mode", async () => {
			const seed = createTestSeed();
			await applySeed(db, seed, { includeContent: true });

			// Add a new content entry to the seed
			const extendedSeed = createUpdatedSeed();
			const posts = extendedSeed.content!["posts"];
			if (!posts) throw new Error("posts missing from seed");
			posts.push({
				id: "post-2",
				slug: "second-post",
				status: "published",
				data: { title: "Second Post", body: "New content" },
			});

			const result = await applySeed(db, extendedSeed, {
				includeContent: true,
				onConflict: "update",
			});

			expect(result.content.updated).toBe(1);
			expect(result.content.created).toBe(1);
		});

		it("clears taxonomy assignments on content update when seed removes them", async () => {
			// Seed with a taxonomy and content that has taxonomy assignments
			const seed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
				taxonomies: [
					{
						name: "categories",
						label: "Categories",
						hierarchical: false,
						collections: ["posts"],
						terms: [
							{ slug: "news", label: "News" },
							{ slug: "tech", label: "Tech" },
						],
					},
				],
				content: {
					posts: [
						{
							id: "post-1",
							slug: "hello-world",
							status: "published",
							data: { title: "Hello" },
							taxonomies: { categories: ["news", "tech"] },
						},
					],
				},
			};
			await applySeed(db, seed, { includeContent: true });

			// Verify both terms are attached
			const beforeRows = await db
				.selectFrom("content_taxonomies")
				.selectAll()
				.where("collection", "=", "posts")
				.execute();
			expect(beforeRows).toHaveLength(2);

			// Re-apply with only one taxonomy term
			const updatedSeed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
				taxonomies: [
					{
						name: "categories",
						label: "Categories",
						hierarchical: false,
						collections: ["posts"],
						terms: [
							{ slug: "news", label: "News" },
							{ slug: "tech", label: "Tech" },
						],
					},
				],
				content: {
					posts: [
						{
							id: "post-1",
							slug: "hello-world",
							status: "published",
							data: { title: "Hello Updated" },
							taxonomies: { categories: ["tech"] },
						},
					],
				},
			};

			await applySeed(db, updatedSeed, {
				includeContent: true,
				onConflict: "update",
			});

			// Should only have "tech" now, not both
			const afterRows = await db
				.selectFrom("content_taxonomies")
				.selectAll()
				.where("collection", "=", "posts")
				.execute();
			expect(afterRows).toHaveLength(1);
		});

		it("clears byline assignments on content update when seed removes them", async () => {
			const seed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
				bylines: [{ id: "byline-1", slug: "jane-doe", displayName: "Jane Doe" }],
				content: {
					posts: [
						{
							id: "post-1",
							slug: "hello-world",
							status: "published",
							data: { title: "Hello" },
							bylines: [{ byline: "byline-1" }],
						},
					],
				},
			};
			await applySeed(db, seed, { includeContent: true });

			// Verify byline is attached
			const beforeRows = await db
				.selectFrom("_emdash_content_bylines")
				.selectAll()
				.where("collection_slug", "=", "posts")
				.execute();
			expect(beforeRows).toHaveLength(1);

			// Re-apply without bylines on the content entry
			const updatedSeed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
				bylines: [{ id: "byline-1", slug: "jane-doe", displayName: "Jane Doe" }],
				content: {
					posts: [
						{
							id: "post-1",
							slug: "hello-world",
							status: "published",
							data: { title: "Hello Updated" },
							// No bylines -- should clear existing
						},
					],
				},
			};

			await applySeed(db, updatedSeed, {
				includeContent: true,
				onConflict: "update",
			});

			// Should have no bylines now
			const afterRows = await db
				.selectFrom("_emdash_content_bylines")
				.selectAll()
				.where("collection_slug", "=", "posts")
				.execute();
			expect(afterRows).toHaveLength(0);
		});
	});
});
