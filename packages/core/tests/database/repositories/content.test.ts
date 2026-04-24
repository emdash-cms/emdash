import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashValidationError } from "../../../src/database/repositories/types.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

describe("ContentRepository", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		// Fresh in-memory database for each test
		db = createDatabase({ url: ":memory:" });
		await runMigrations(db);
		repo = new ContentRepository(db);
		registry = new SchemaRegistry(db);

		// Create collections needed for tests (this creates ec_post and ec_page tables)
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createCollection({
			slug: "page",
			label: "Pages",
			labelSingular: "Page",
		});

		// Add fields to both collections
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("post", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("page", {
			slug: "title",
			label: "Title",
			type: "string",
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("create", () => {
		it("should create content with minimal data", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test Post" },
			});

			expect(content.id).toBeDefined();
			expect(content.type).toBe("post");
			expect(content.data).toEqual({ title: "Test Post" });
			expect(content.status).toBe("draft");
			expect(content.createdAt).toBeDefined();
			expect(content.updatedAt).toBeDefined();
		});

		it("should create content with all fields", async () => {
			const content = await repo.create({
				type: "post",
				slug: "test-post",
				data: { title: "Test Post", content: "Body" },
				status: "published",
				authorId: "author-1",
			});

			expect(content.id).toBeDefined();
			expect(content.type).toBe("post");
			expect(content.slug).toBe("test-post");
			expect(content.data).toEqual({ title: "Test Post", content: "Body" });
			expect(content.status).toBe("published");
			expect(content.authorId).toBe("author-1");
		});

		it("should throw validation error when type is missing", async () => {
			await expect(
				repo.create({
					type: "",
					data: { title: "Test" },
				}),
			).rejects.toThrow(EmDashValidationError);
		});

		it("should throw error for duplicate type+slug", async () => {
			await repo.create({
				type: "post",
				slug: "duplicate-slug",
				data: { title: "First" },
			});

			await expect(
				repo.create({
					type: "post",
					slug: "duplicate-slug",
					data: { title: "Second" },
				}),
			).rejects.toThrow();
		});

		it("should allow same slug for different types", async () => {
			await repo.create({
				type: "post",
				slug: "same-slug",
				data: { title: "Post" },
			});

			await expect(
				repo.create({
					type: "page",
					slug: "same-slug",
					data: { title: "Page" },
				}),
			).resolves.not.toThrow();
		});

		it("should allow null slug", async () => {
			const content = await repo.create({
				type: "post",
				slug: null,
				data: { title: "No slug" },
			});

			expect(content.slug).toBeNull();
		});

		it("should default status to draft", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			expect(content.status).toBe("draft");
		});

		it("should generate unique ID", async () => {
			const content1 = await repo.create({
				type: "post",
				data: { title: "First" },
			});

			const content2 = await repo.create({
				type: "post",
				data: { title: "Second" },
			});

			expect(content1.id).not.toBe(content2.id);
		});

		it("should store complex nested data in JSON columns", async () => {
			// Portable Text content is stored as JSON
			const portableTextContent = [
				{
					_type: "block",
					style: "normal",
					children: [{ _type: "span", text: "Hello world" }],
				},
				{
					_type: "block",
					style: "h1",
					children: [{ _type: "span", text: "Heading", marks: ["bold"] }],
				},
			];

			const content = await repo.create({
				type: "post",
				data: {
					title: "Complex Post",
					content: portableTextContent,
				},
			});

			expect(content.data.title).toBe("Complex Post");
			expect(content.data.content).toEqual(portableTextContent);
		});
	});

	describe("findById", () => {
		it("should find content by ID", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			const found = await repo.findById("post", created.id);

			expect(found).not.toBeNull();
			expect(found!.id).toBe(created.id);
			expect(found!.data).toEqual(created.data);
		});

		it("should return null for non-existent ID", async () => {
			const found = await repo.findById("post", "non-existent-id");
			expect(found).toBeNull();
		});

		it("should return null when type doesn't match", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			const found = await repo.findById("page", created.id);
			expect(found).toBeNull();
		});

		it("should not find soft-deleted content", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await repo.delete("post", created.id);

			const found = await repo.findById("post", created.id);
			expect(found).toBeNull();
		});
	});

	describe("findBySlug", () => {
		it("should find content by slug", async () => {
			await repo.create({
				type: "post",
				slug: "test-slug",
				data: { title: "Test" },
			});

			const found = await repo.findBySlug("post", "test-slug");

			expect(found).not.toBeNull();
			expect(found!.slug).toBe("test-slug");
		});

		it("should return null for non-existent slug", async () => {
			const found = await repo.findBySlug("post", "non-existent");
			expect(found).toBeNull();
		});

		it("should return correct content when same slug exists for different types", async () => {
			await repo.create({
				type: "post",
				slug: "shared-slug",
				data: { title: "Post" },
			});

			await repo.create({
				type: "page",
				slug: "shared-slug",
				data: { title: "Page" },
			});

			const post = await repo.findBySlug("post", "shared-slug");
			const page = await repo.findBySlug("page", "shared-slug");

			expect(post!.type).toBe("post");
			expect(post!.data.title).toBe("Post");
			expect(page!.type).toBe("page");
			expect(page!.data.title).toBe("Page");
		});

		it("should not find soft-deleted content", async () => {
			const created = await repo.create({
				type: "post",
				slug: "test-slug",
				data: { title: "Test" },
			});

			await repo.delete("post", created.id);

			const found = await repo.findBySlug("post", "test-slug");
			expect(found).toBeNull();
		});
	});

	describe("findMany", () => {
		beforeEach(async () => {
			// Create test data
			for (let i = 0; i < 5; i++) {
				await repo.create({
					type: "post",
					slug: `post-${i}`,
					data: { title: `Post ${i}` },
					status: i % 2 === 0 ? "published" : "draft",
					authorId: i < 3 ? "author-1" : "author-2",
				});
			}
		});

		it("should return all content by default", async () => {
			const result = await repo.findMany("post");

			expect(result.items).toHaveLength(5);
		});

		it("should filter by status", async () => {
			const result = await repo.findMany("post", {
				where: { status: "published" },
			});

			expect(result.items).toHaveLength(3);
			expect(result.items.every((item) => item.status === "published")).toBe(true);
		});

		it("should filter by authorId", async () => {
			const result = await repo.findMany("post", {
				where: { authorId: "author-1" },
			});

			expect(result.items).toHaveLength(3);
			expect(result.items.every((item) => item.authorId === "author-1")).toBe(true);
		});

		it("should filter by both status and authorId", async () => {
			const result = await repo.findMany("post", {
				where: {
					status: "published",
					authorId: "author-1",
				},
			});

			expect(result.items).toHaveLength(2);
		});

		it("should apply limit", async () => {
			const result = await repo.findMany("post", { limit: 2 });

			expect(result.items).toHaveLength(2);
		});

		it("should support cursor pagination", async () => {
			const page1 = await repo.findMany("post", { limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.nextCursor).toBeDefined();

			const page2 = await repo.findMany("post", {
				limit: 2,
				cursor: page1.nextCursor,
			});
			expect(page2.items).toHaveLength(2);

			// Items should be different
			const page1Ids = page1.items.map((i) => i.id);
			const page2Ids = page2.items.map((i) => i.id);
			expect(page1Ids).not.toEqual(page2Ids);
		});

		it("should not include nextCursor when no more items", async () => {
			const result = await repo.findMany("post", { limit: 10 });

			expect(result.items).toHaveLength(5);
			expect(result.nextCursor).toBeUndefined();
		});

		it("should order by createdAt desc by default", async () => {
			const result = await repo.findMany("post");

			// Items should be in descending order (newest first)
			for (let i = 1; i < result.items.length; i++) {
				expect(result.items[i - 1].createdAt >= result.items[i].createdAt).toBe(true);
			}
		});

		it("should support custom ordering", async () => {
			const result = await repo.findMany("post", {
				orderBy: {
					field: "createdAt",
					direction: "asc",
				},
			});

			// Items should be in ascending order (oldest first)
			for (let i = 1; i < result.items.length; i++) {
				expect(result.items[i - 1].createdAt <= result.items[i].createdAt).toBe(true);
			}
		});

		it("should default limit to 50", async () => {
			// Create more than 50 items
			for (let i = 0; i < 60; i++) {
				await repo.create({
					type: "page",
					data: { title: `Page ${i}` },
				});
			}

			const result = await repo.findMany("page");

			expect(result.items.length).toBeLessThanOrEqual(50);
		});

		it("should cap limit at 100", async () => {
			const result = await repo.findMany("post", { limit: 200 });

			// Even with limit: 200, should not return more than 100
			expect(result.items.length).toBeLessThanOrEqual(100);
		});

		it("should not include soft-deleted content", async () => {
			const toDelete = await repo.create({
				type: "post",
				data: { title: "To Delete" },
			});

			await repo.delete("post", toDelete.id);

			const result = await repo.findMany("post");

			expect(result.items.every((item) => item.id !== toDelete.id)).toBe(true);
		});

		it("should return empty array when no items match", async () => {
			const result = await repo.findMany("page");

			expect(result.items).toEqual([]);
			expect(result.nextCursor).toBeUndefined();
		});

		describe("search", () => {
			// Regression guard for the admin "search doesn't find existing
			// content" bug: clients used to filter client-side against whatever
			// pages had already been fetched, so results past the first page
			// were invisible. The repo now has to honor search server-side
			// across the whole collection.
			it("finds items by a title substring match", async () => {
				await repo.create({ type: "page", slug: "bleeding", data: { title: "Bleeding" } });
				await repo.create({ type: "page", slug: "unrelated", data: { title: "Unrelated" } });

				const result = await repo.findMany("page", { where: { search: "leed" } });

				expect(result.items).toHaveLength(1);
				expect(result.items[0]!.slug).toBe("bleeding");
			});

			it("is case-insensitive", async () => {
				await repo.create({ type: "page", slug: "mixed-case", data: { title: "MiXeD CaSe" } });

				const result = await repo.findMany("page", { where: { search: "mixed case" } });

				expect(result.items.map((i) => i.slug)).toEqual(["mixed-case"]);
			});

			it("matches against slug for collections without a title column", async () => {
				// `page` has a title column by default in the fixture, but slug
				// is the universal fallback — prove it participates.
				await repo.create({ type: "page", slug: "no-title-slug", data: {} });

				const result = await repo.findMany("page", { where: { search: "no-title" } });

				expect(result.items).toHaveLength(1);
			});

			it("searches slug-only collections that have no title/name columns", async () => {
				// Create a collection that has neither `title` nor `name` — the
				// search must still work via the universal `slug` column.
				await registry.createCollection({
					slug: "bare",
					label: "Bare",
					labelSingular: "Bare",
				});
				await repo.create({ type: "bare", slug: "target-slug", data: {} });
				await repo.create({ type: "bare", slug: "other-slug", data: {} });

				const result = await repo.findMany("bare", { where: { search: "target" } });

				expect(result.items.map((i) => i.slug)).toEqual(["target-slug"]);
				expect(result.total).toBe(1);
			});

			it("keeps list items and total consistent across pagination", async () => {
				// Regression guard: both queries must see the same WHERE.
				// A bug where only one side consumed the search spec would
				// leave total correct but items wrong (or vice versa).
				for (let i = 0; i < 6; i++) {
					await repo.create({
						type: "page",
						slug: `match-${i}`,
						data: { title: `Match ${i}` },
					});
				}
				await repo.create({ type: "page", slug: "miss", data: { title: "Miss" } });

				const page1 = await repo.findMany("page", {
					limit: 2,
					where: { search: "match" },
					orderBy: { field: "slug", direction: "asc" },
				});

				expect(page1.items).toHaveLength(2);
				expect(page1.total).toBe(6);
				expect(page1.nextCursor).toBeDefined();

				const page2 = await repo.findMany("page", {
					limit: 2,
					cursor: page1.nextCursor,
					where: { search: "match" },
					orderBy: { field: "slug", direction: "asc" },
				});

				expect(page2.total).toBe(6); // total stays stable across pages
				expect(page2.items.every((i) => i.slug?.startsWith("match-"))).toBe(true);
			});

			it("escapes LIKE wildcards so they don't act as patterns", async () => {
				await repo.create({ type: "page", slug: "normal", data: { title: "Normal" } });
				await repo.create({ type: "page", slug: "literal", data: { title: "Has % in it" } });

				// A plain `%` in a LIKE pattern would match everything; the
				// repo must escape it and only return the row that literally
				// contains the character.
				const result = await repo.findMany("page", { where: { search: "%" } });

				expect(result.items.map((i) => i.slug)).toEqual(["literal"]);
			});

			it("ignores empty / whitespace search input", async () => {
				const result = await repo.findMany("page", { where: { search: "   " } });

				expect(result.items).toHaveLength(0); // no pages created in this test
			});

			it("handles pathological search input without throwing", async () => {
				await repo.create({ type: "page", slug: "shorty", data: { title: "shorty" } });

				// A 1000-char input should be truncated before reaching SQL;
				// we don't care what it matches, only that the query succeeds.
				const massive = "z".repeat(5000);

				await expect(repo.findMany("page", { where: { search: massive } })).resolves.toBeDefined();
			});
		});

		describe("total", () => {
			// Regression guard for the admin "denominator grows as you page
			// forward" bug: each list response must include the full count so
			// the UI doesn't have to reverse-engineer it from accumulated
			// pages.
			it("reports total rows regardless of limit", async () => {
				const result = await repo.findMany("post", { limit: 2 });

				expect(result.items).toHaveLength(2);
				expect(result.total).toBe(5);
			});

			it("total respects the where clause", async () => {
				const result = await repo.findMany("post", {
					limit: 2,
					where: { status: "published" },
				});

				expect(result.total).toBe(3);
			});

			it("total respects the search clause", async () => {
				await repo.create({
					type: "page",
					slug: "alpha",
					data: { title: "Alpha" },
				});
				await repo.create({
					type: "page",
					slug: "beta",
					data: { title: "Beta" },
				});
				await repo.create({
					type: "page",
					slug: "alpha-two",
					data: { title: "Alpha two" },
				});

				const result = await repo.findMany("page", {
					limit: 1,
					where: { search: "alpha" },
				});

				expect(result.items).toHaveLength(1);
				expect(result.total).toBe(2);
			});
		});

		describe("orderBy", () => {
			// Regression guard for "table headers aren't sort controls": the
			// admin now sends orderBy={field,direction} — the repo must accept
			// the columns the UI wants to expose, not just dates.
			it("accepts status as an order field", async () => {
				const result = await repo.findMany("post", {
					orderBy: { field: "status", direction: "asc" },
				});

				// alphabetical asc places 'draft' before 'published'
				expect(result.items[0]!.status).toBe("draft");
			});

			it("accepts locale as an order field", async () => {
				await repo.findMany("post", {
					orderBy: { field: "locale", direction: "desc" },
				});
				// no throw = pass
			});

			it("rejects unknown fields to block column enumeration", async () => {
				await expect(
					repo.findMany("post", {
						orderBy: { field: "password", direction: "asc" },
					}),
				).rejects.toThrow(EmDashValidationError);
			});
		});
	});

	describe("update", () => {
		it("should update content data", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Original" },
			});

			const updated = await repo.update("post", created.id, {
				data: { title: "Updated" },
			});

			expect(updated.data.title).toBe("Updated");
			expect(updated.id).toBe(created.id);
		});

		it("should update status", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
				status: "draft",
			});

			const updated = await repo.update("post", created.id, {
				status: "published",
			});

			expect(updated.status).toBe("published");
		});

		it("should update slug", async () => {
			const created = await repo.create({
				type: "post",
				slug: "old-slug",
				data: { title: "Test" },
			});

			const updated = await repo.update("post", created.id, {
				slug: "new-slug",
			});

			expect(updated.slug).toBe("new-slug");
		});

		it("should update publishedAt", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			const publishedAt = new Date().toISOString();
			const updated = await repo.update("post", created.id, {
				publishedAt,
			});

			expect(updated.publishedAt).toBe(publishedAt);
		});

		it("should support partial updates", async () => {
			const created = await repo.create({
				type: "post",
				slug: "test-slug",
				data: { title: "Test", content: "Original content" },
				status: "draft",
			});

			const updated = await repo.update("post", created.id, {
				status: "published",
			});

			// Only status should change
			expect(updated.status).toBe("published");
			expect(updated.slug).toBe("test-slug");
			expect(updated.data).toEqual({
				title: "Test",
				content: "Original content",
			});
		});

		it("should throw error for non-existent content", async () => {
			await expect(repo.update("post", "non-existent", { status: "published" })).rejects.toThrow(
				"Content not found",
			);
		});

		it("should persist removal of array items in JSON fields (multiSelect)", async () => {
			// Add a multiSelect (JSON) field to the post collection
			await registry.createField("post", {
				slug: "tags",
				label: "Tags",
				type: "multiSelect",
			});

			const created = await repo.create({
				type: "post",
				data: { title: "Test", tags: ["news", "sports", "tech"] },
			});

			expect(created.data.tags).toEqual(["news", "sports", "tech"]);

			// Remove "sports" from the array (simulates unchecking a checkbox)
			const updated = await repo.update("post", created.id, {
				data: { title: "Test", tags: ["news", "tech"] },
			});

			expect(updated.data.tags).toEqual(["news", "tech"]);

			// Verify it persists when re-reading
			const fetched = await repo.findById("post", updated.id);
			expect(fetched!.data.tags).toEqual(["news", "tech"]);
		});

		it("should persist empty array in JSON fields (multiSelect)", async () => {
			await registry.createField("post", {
				slug: "categories",
				label: "Categories",
				type: "multiSelect",
			});

			const created = await repo.create({
				type: "post",
				data: { title: "Test", categories: ["news"] },
			});

			// Uncheck all items
			const updated = await repo.update("post", created.id, {
				data: { title: "Test", categories: [] },
			});

			expect(updated.data.categories).toEqual([]);

			const fetched = await repo.findById("post", updated.id);
			expect(fetched!.data.categories).toEqual([]);
		});

		it("should not update soft-deleted content", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await repo.delete("post", created.id);

			await expect(repo.update("post", created.id, { status: "published" })).rejects.toThrow(
				"Content not found",
			);
		});

		it("should update updatedAt timestamp", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			// Small delay to ensure timestamp difference
			await new Promise((resolve) => setTimeout(resolve, 10));

			const updated = await repo.update("post", created.id, {
				data: { title: "Updated" },
			});

			expect(updated.updatedAt > created.updatedAt).toBe(true);
		});
	});

	describe("delete", () => {
		it("should soft delete content", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			const result = await repo.delete("post", created.id);

			expect(result).toBe(true);

			// Verify content is not found
			const found = await repo.findById("post", created.id);
			expect(found).toBeNull();
		});

		it("should return true for successful deletion", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			const result = await repo.delete("post", created.id);

			expect(result).toBe(true);
		});

		it("should return false for non-existent content", async () => {
			const result = await repo.delete("post", "non-existent");

			expect(result).toBe(false);
		});

		it("should return false for already deleted content", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await repo.delete("post", created.id);
			const result = await repo.delete("post", created.id);

			expect(result).toBe(false);
		});

		it("should set deleted_at timestamp", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await repo.delete("post", created.id);

			// Directly query database to check deleted_at
			// Use raw SQL since ec_post is a dynamic table
			const { sql } = await import("kysely");
			const result = await sql<{ deleted_at: string | null }>`
				SELECT deleted_at FROM ec_post WHERE id = ${created.id}
			`.execute(db);

			expect(result.rows[0]?.deleted_at).toBeDefined();
			expect(result.rows[0]?.deleted_at).not.toBeNull();
		});
	});

	describe("count", () => {
		beforeEach(async () => {
			// Create test data
			for (let i = 0; i < 10; i++) {
				await repo.create({
					type: "post",
					data: { title: `Post ${i}` },
					status: i % 2 === 0 ? "published" : "draft",
					authorId: i < 5 ? "author-1" : "author-2",
				});
			}
		});

		it("should count all content of a type", async () => {
			const count = await repo.count("post");

			expect(count).toBe(10);
		});

		it("should count by status", async () => {
			const count = await repo.count("post", { status: "published" });

			expect(count).toBe(5);
		});

		it("should count by authorId", async () => {
			const count = await repo.count("post", { authorId: "author-1" });

			expect(count).toBe(5);
		});

		it("should count by both status and authorId", async () => {
			const count = await repo.count("post", {
				status: "published",
				authorId: "author-1",
			});

			// Posts 0, 2, 4 are published by author-1
			expect(count).toBe(3);
		});

		it("should return 0 when no items match", async () => {
			const count = await repo.count("page");

			expect(count).toBe(0);
		});

		it("should not count soft-deleted content", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "To Delete" },
			});

			await repo.delete("post", created.id);

			const count = await repo.count("post");

			expect(count).toBe(10); // Not 11
		});
	});

	describe("integration scenarios", () => {
		it("should handle full CRUD lifecycle", async () => {
			// Create
			const created = await repo.create({
				type: "post",
				slug: "test-post",
				data: { title: "Test Post", content: "Original content" },
				status: "draft",
			});

			expect(created.id).toBeDefined();
			expect(created.status).toBe("draft");

			// Read
			const found = await repo.findBySlug("post", "test-post");
			expect(found!.id).toBe(created.id);

			// Update
			const updated = await repo.update("post", created.id, {
				data: { title: "Updated Post", content: "New content" },
				status: "published",
			});

			expect(updated.data.title).toBe("Updated Post");
			expect(updated.status).toBe("published");

			// Delete
			const deleted = await repo.delete("post", created.id);
			expect(deleted).toBe(true);

			// Verify not found
			const notFound = await repo.findById("post", created.id);
			expect(notFound).toBeNull();
		});

		it("should handle concurrent operations", async () => {
			// Create multiple items concurrently
			const promises = Array.from({ length: 10 }, (_, i) =>
				repo.create({
					type: "post",
					data: { title: `Post ${i}` },
				}),
			);

			const created = await Promise.all(promises);

			expect(created).toHaveLength(10);
			expect(new Set(created.map((c) => c.id)).size).toBe(10); // All unique IDs
		});

		it("should persist complex nested data structures", async () => {
			// Use the content field (portableText type) for complex nested data
			const complexContent = [
				{
					_type: "block",
					style: "h1",
					children: [{ _type: "span", text: "Title" }],
				},
				{
					_type: "block",
					style: "normal",
					children: [
						{ _type: "span", text: "Bold", marks: ["bold"] },
						{ _type: "span", text: " and " },
						{ _type: "span", text: "italic", marks: ["italic"] },
					],
				},
			];

			const created = await repo.create({
				type: "post",
				data: {
					title: "Complex Post",
					content: complexContent,
				},
			});

			const retrieved = await repo.findById("post", created.id);

			expect(retrieved!.data.title).toBe("Complex Post");
			expect(retrieved!.data.content).toEqual(complexContent);
		});
	});
});
