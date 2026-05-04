import type { Kysely, KyselyPlugin } from "kysely";
import { describe, it, expect, afterEach } from "vitest";

import { handleDashboardStats } from "../../../src/api/handlers/dashboard.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createPostFixture, createPageFixture } from "../../utils/fixtures.js";
import {
	setupTestDatabase,
	setupTestDatabaseWithCollections,
	teardownTestDatabase,
} from "../../utils/test-db.js";

const rejectCompoundSelectPlugin = {
	transformQuery(args) {
		if (JSON.stringify(args.node).includes(" UNION ALL ")) {
			throw new Error("D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR");
		}

		return args.node;
	},
	async transformResult(args) {
		return args.result;
	},
} satisfies KyselyPlugin;

describe("Dashboard Handlers", () => {
	describe("handleDashboardStats", () => {
		let db: Kysely<Database>;

		afterEach(async () => {
			await teardownTestDatabase(db);
		});

		it("returns empty stats when no collections exist", async () => {
			db = await setupTestDatabase();

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			expect(result.data).toBeDefined();
			expect(result.data!.collections).toEqual([]);
			expect(result.data!.mediaCount).toBe(0);
			expect(result.data!.userCount).toBe(0);
			expect(result.data!.recentItems).toEqual([]);
		});

		it("returns collection stats with correct counts", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);

			// Create some posts with different statuses
			await contentRepo.create(createPostFixture({ slug: "post-1" }));
			await contentRepo.create(createPostFixture({ slug: "post-2", status: "published" }));
			await contentRepo.create(createPostFixture({ slug: "post-3", status: "published" }));

			// Create a draft page
			await contentRepo.create(createPageFixture({ slug: "page-1" }));

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const { collections } = result.data!;

			// Both collections should be present
			expect(collections).toHaveLength(2);

			const postStats = collections.find((c) => c.slug === "post");
			expect(postStats).toBeDefined();
			expect(postStats!.label).toBe("Posts");
			expect(postStats!.total).toBe(3);
			expect(postStats!.published).toBe(2);
			expect(postStats!.draft).toBe(1);

			const pageStats = collections.find((c) => c.slug === "page");
			expect(pageStats).toBeDefined();
			expect(pageStats!.label).toBe("Pages");
			expect(pageStats!.total).toBe(1);
			expect(pageStats!.published).toBe(0);
			expect(pageStats!.draft).toBe(1);
		});

		it("returns recent items across collections", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);

			await contentRepo.create(createPostFixture({ slug: "post-1" }));
			// Small delay for distinct updated_at
			await new Promise((r) => setTimeout(r, 10));
			await contentRepo.create(createPageFixture({ slug: "page-1" }));

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const { recentItems } = result.data!;

			expect(recentItems.length).toBeGreaterThanOrEqual(2);

			// Most recently updated should be first
			expect(recentItems[0]!.collection).toBe("page");
			expect(recentItems[0]!.collectionLabel).toBe("Pages");
			expect(recentItems[0]!.slug).toBe("page-1");
			expect(recentItems[0]!.status).toBe("draft");

			expect(recentItems[1]!.collection).toBe("post");
			expect(recentItems[1]!.collectionLabel).toBe("Posts");
			expect(recentItems[1]!.slug).toBe("post-1");
		});

		it("does not use a compound recent-items query that exceeds D1 limits", async () => {
			db = await setupTestDatabase();
			const registry = new SchemaRegistry(db);
			const contentRepo = new ContentRepository(db);

			for (let i = 0; i < 12; i++) {
				const slug = `section_${String(i).padStart(2, "0")}`;
				await registry.createCollection({
					slug,
					label: `Section ${i}`,
					labelSingular: "Section",
				});
				await registry.createField(slug, {
					slug: "title",
					label: "Title",
					type: "string",
				});
				await contentRepo.create({
					type: slug,
					slug: `item-${i}`,
					data: { title: `Item ${i}` },
					status: "draft",
				});
			}

			const d1LikeDb = db.withPlugin(rejectCompoundSelectPlugin);
			const result = await handleDashboardStats(d1LikeDb);

			expect(result.success).toBe(true);
			expect(result.data!.recentItems).toHaveLength(10);
			expect(result.data!.recentItems.every((item) => item.collection.startsWith("section_"))).toBe(true);
		});

		it("recent items use title field when available", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);

			// setupTestDatabaseWithCollections creates post/page with title fields
			await contentRepo.create(
				createPostFixture({
					slug: "my-post",
					data: { title: "My Great Post", content: [] },
				}),
			);

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const postItem = result.data!.recentItems.find((i) => i.slug === "my-post");
			expect(postItem).toBeDefined();
			expect(postItem!.title).toBe("My Great Post");
		});

		it("recent items fall back to slug when collection has no title field", async () => {
			db = await setupTestDatabase();
			const registry = new SchemaRegistry(db);

			// Create a collection without a title field
			await registry.createCollection({
				slug: "events",
				label: "Events",
				labelSingular: "Event",
			});
			await registry.createField("events", {
				slug: "date",
				label: "Date",
				type: "datetime",
			});

			const contentRepo = new ContentRepository(db);
			await contentRepo.create({
				type: "events",
				slug: "launch-party",
				data: { date: "2026-03-01" },
				status: "draft",
			});

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const eventItem = result.data!.recentItems.find((i) => i.collection === "events");
			expect(eventItem).toBeDefined();
			// No title field, should fall back to slug
			expect(eventItem!.title).toBe("launch-party");
		});

		it("excludes soft-deleted items from recent items", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);

			const post = await contentRepo.create(createPostFixture({ slug: "will-delete" }));
			await contentRepo.create(createPostFixture({ slug: "will-keep" }));

			// Soft-delete the first post
			await contentRepo.delete("post", post.id);

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const slugs = result.data!.recentItems.map((i) => i.slug);
			expect(slugs).toContain("will-keep");
			expect(slugs).not.toContain("will-delete");
		});

		it("limits recent items to 10", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);

			// Create 15 posts
			for (let i = 0; i < 15; i++) {
				await contentRepo.create(createPostFixture({ slug: `post-${String(i).padStart(2, "0")}` }));
			}

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			expect(result.data!.recentItems).toHaveLength(10);
		});

		it("recent items are ordered by updated_at descending", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);

			await contentRepo.create(createPostFixture({ slug: "oldest" }));
			await new Promise((r) => setTimeout(r, 10));
			await contentRepo.create(createPostFixture({ slug: "middle" }));
			await new Promise((r) => setTimeout(r, 10));
			await contentRepo.create(createPostFixture({ slug: "newest" }));

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const slugs = result.data!.recentItems.map((i) => i.slug);
			expect(slugs).toEqual(["newest", "middle", "oldest"]);
		});

		it("counts exclude soft-deleted items", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);

			const post = await contentRepo.create(createPostFixture({ slug: "to-delete" }));
			await contentRepo.create(createPostFixture({ slug: "to-keep" }));
			await contentRepo.delete("post", post.id);

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const postStats = result.data!.collections.find((c) => c.slug === "post");
			// count() in ContentRepository filters deleted_at IS NULL
			expect(postStats!.total).toBe(1);
		});

		it("returns camelCase keys in recent items", async () => {
			db = await setupTestDatabaseWithCollections();
			const contentRepo = new ContentRepository(db);
			await contentRepo.create(createPostFixture());

			const result = await handleDashboardStats(db);

			expect(result.success).toBe(true);
			const item = result.data!.recentItems[0]!;
			// Verify camelCase API shape
			expect(item).toHaveProperty("id");
			expect(item).toHaveProperty("collection");
			expect(item).toHaveProperty("collectionLabel");
			expect(item).toHaveProperty("title");
			expect(item).toHaveProperty("slug");
			expect(item).toHaveProperty("status");
			expect(item).toHaveProperty("updatedAt");
			expect(item).toHaveProperty("authorId");
			// Should NOT have snake_case keys
			expect(item).not.toHaveProperty("collection_label");
			expect(item).not.toHaveProperty("updated_at");
			expect(item).not.toHaveProperty("author_id");
		});
	});
});
