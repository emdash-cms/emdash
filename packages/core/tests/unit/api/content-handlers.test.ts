import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	handleContentCreate,
	handleContentDuplicate,
	handleContentGet,
	handleContentList,
	handleContentUpdate,
} from "../../../src/api/index.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("Content Handlers — auto-slug generation", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		// Add a "name" field to the page collection so we can test name-based slug generation
		const registry = new SchemaRegistry(db);
		await registry.createField("page", { slug: "name", label: "Name", type: "string" });
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("handleContentCreate", () => {
		it("should auto-generate slug from title when slug is omitted", async () => {
			const result = await handleContentCreate(db, "post", {
				data: { title: "Hello World" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBe("hello-world");
		});

		it("should auto-generate slug from name when title is absent", async () => {
			const result = await handleContentCreate(db, "page", {
				data: { name: "My Widget" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBe("my-widget");
		});

		it("should prefer title over name for slug generation", async () => {
			const result = await handleContentCreate(db, "page", {
				data: { title: "From Title", name: "From Name" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBe("from-title");
		});

		it("should respect explicit slug and not auto-generate", async () => {
			const result = await handleContentCreate(db, "post", {
				data: { title: "Hello World" },
				slug: "custom-slug",
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBe("custom-slug");
		});

		it("should handle slug collisions by appending numeric suffix", async () => {
			// Create first item with the slug
			await handleContentCreate(db, "post", {
				data: { title: "Hello World" },
			});

			// Create second item with same title — should get unique slug
			const result = await handleContentCreate(db, "post", {
				data: { title: "Hello World" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBe("hello-world-1");
		});

		it("should increment suffix on repeated collisions", async () => {
			await handleContentCreate(db, "post", {
				data: { title: "Hello World" },
			});
			await handleContentCreate(db, "post", {
				data: { title: "Hello World" },
			});

			const result = await handleContentCreate(db, "post", {
				data: { title: "Hello World" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBe("hello-world-2");
		});

		it("should leave slug null when no title or name is present", async () => {
			// `data: {}` — no title, no name. Slug source isn't there, so the
			// auto-generator has nothing to work with.
			const result = await handleContentCreate(db, "post", {
				data: {},
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBeNull();
		});

		it("rejects non-string title via field validation", async () => {
			// Field validation now enforces type: string. This test used to
			// document the slug-generator's silent-skip behavior on a
			// non-string title, which only happened because no validation
			// ran. With validation in place, the create is rejected.
			const result = await handleContentCreate(db, "post", {
				data: { title: 42 },
			});

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("VALIDATION_ERROR");
			expect(result.error?.message).toMatch(/title/);
		});

		it("should leave slug null when title is empty string", async () => {
			const result = await handleContentCreate(db, "post", {
				data: { title: "" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBeNull();
		});

		it("should handle unicode titles", async () => {
			const result = await handleContentCreate(db, "post", {
				data: { title: "Café Naïve" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.slug).toBe("cafe-naive");
		});

		it("should allow same auto-slug in different collections", async () => {
			const postResult = await handleContentCreate(db, "post", {
				data: { title: "About" },
			});
			const pageResult = await handleContentCreate(db, "page", {
				data: { title: "About" },
			});

			expect(postResult.success).toBe(true);
			expect(pageResult.success).toBe(true);
			expect(postResult.data?.item.slug).toBe("about");
			expect(pageResult.data?.item.slug).toBe("about");
		});

		it("preserves publishedAt and createdAt when provided — content migration use case", async () => {
			const originalCreated = "2019-03-15T10:30:00.000Z";
			const originalPublished = "2019-03-16T09:00:00.000Z";

			const result = await handleContentCreate(db, "post", {
				data: { title: "Migrated Post" },
				createdAt: originalCreated,
				publishedAt: originalPublished,
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.createdAt).toBe(originalCreated);
			expect(result.data?.item.publishedAt).toBe(originalPublished);
		});
	});

	describe("handleContentDuplicate", () => {
		it("should generate slug from duplicated title", async () => {
			const original = await handleContentCreate(db, "post", {
				data: { title: "My Post" },
				slug: "my-post",
			});

			const result = await handleContentDuplicate(db, "post", original.data!.item.id);

			expect(result.success).toBe(true);
			// Title becomes "My Post (Copy)", slug should be generated from it
			expect(result.data?.item.slug).toBe("my-post-copy");
		});

		it("should handle duplicate slug collision from copy", async () => {
			const original = await handleContentCreate(db, "post", {
				data: { title: "My Post" },
				slug: "my-post",
			});

			// First duplicate
			const dup1 = await handleContentDuplicate(db, "post", original.data!.item.id);
			expect(dup1.data?.item.slug).toBe("my-post-copy");

			// Second duplicate — "My Post (Copy)" title slugifies to "my-post-copy"
			// which now collides with the first duplicate
			const dup2 = await handleContentDuplicate(db, "post", original.data!.item.id);
			expect(dup2.success).toBe(true);
			expect(dup2.data?.item.slug).toBe("my-post-copy-1");
		});
	});

	describe("byline hydration and assignment", () => {
		it("should assign and return bylines on create", async () => {
			const bylineRepo = new BylineRepository(db);
			const byline = await bylineRepo.create({
				slug: "author-one",
				displayName: "Author One",
			});

			const created = await handleContentCreate(db, "post", {
				data: { title: "Bylined" },
				bylines: [{ bylineId: byline.id, roleLabel: "Writer" }],
			});

			expect(created.success).toBe(true);
			expect(created.data?.item.primaryBylineId).toBe(byline.id);
			expect(created.data?.item.byline?.id).toBe(byline.id);
			expect(created.data?.item.bylines).toHaveLength(1);
			expect(created.data?.item.bylines?.[0]?.roleLabel).toBe("Writer");
		});

		it("should return bylines on get and list", async () => {
			const bylineRepo = new BylineRepository(db);
			const first = await bylineRepo.create({ slug: "first", displayName: "First" });
			const second = await bylineRepo.create({ slug: "second", displayName: "Second" });

			const created = await handleContentCreate(db, "post", {
				data: { title: "Order Test" },
				bylines: [{ bylineId: second.id }, { bylineId: first.id }],
			});
			expect(created.success).toBe(true);
			const contentId = created.data!.item.id;

			const fetched = await handleContentGet(db, "post", contentId);
			expect(fetched.success).toBe(true);
			expect(fetched.data?.item.bylines?.[0]?.byline.id).toBe(second.id);
			expect(fetched.data?.item.bylines?.[1]?.byline.id).toBe(first.id);
			expect(fetched.data?.item.byline?.id).toBe(second.id);

			const listed = await handleContentList(db, "post", {});
			expect(listed.success).toBe(true);
			const listedItem = listed.data?.items.find((item) => item.id === contentId);
			expect(listedItem?.byline?.id).toBe(second.id);
			expect(listedItem?.bylines?.[0]?.byline.id).toBe(second.id);
		});

		it("should update byline ordering on update", async () => {
			const bylineRepo = new BylineRepository(db);
			const first = await bylineRepo.create({ slug: "first-upd", displayName: "First" });
			const second = await bylineRepo.create({ slug: "second-upd", displayName: "Second" });

			const created = await handleContentCreate(db, "post", {
				data: { title: "Update Bylines" },
				bylines: [{ bylineId: first.id }, { bylineId: second.id }],
			});
			expect(created.success).toBe(true);

			const updated = await handleContentUpdate(db, "post", created.data!.item.id, {
				bylines: [{ bylineId: second.id }, { bylineId: first.id }],
			});

			expect(updated.success).toBe(true);
			expect(updated.data?.item.primaryBylineId).toBe(second.id);
			expect(updated.data?.item.bylines?.[0]?.byline.id).toBe(second.id);
			expect(updated.data?.item.bylines?.[1]?.byline.id).toBe(first.id);
		});

		it("should copy bylines when duplicating", async () => {
			const bylineRepo = new BylineRepository(db);
			const byline = await bylineRepo.create({
				slug: "dup-author",
				displayName: "Dup Author",
			});

			const original = await handleContentCreate(db, "post", {
				data: { title: "Duplicate With Bylines" },
				bylines: [{ bylineId: byline.id }],
			});
			expect(original.success).toBe(true);

			const duplicated = await handleContentDuplicate(db, "post", original.data!.item.id);
			expect(duplicated.success).toBe(true);
			expect(duplicated.data?.item.byline?.id).toBe(byline.id);
			expect(duplicated.data?.item.bylines).toHaveLength(1);
		});
	});

	describe("handleContentUpdate — publishedAt override", () => {
		it("persists publishedAt when provided", async () => {
			const created = await handleContentCreate(db, "post", { data: { title: "Hi" } });
			expect(created.success).toBe(true);

			const newPublishedAt = "2019-03-16T09:00:00.000Z";
			const updated = await handleContentUpdate(db, "post", created.data!.item.id, {
				publishedAt: newPublishedAt,
			});

			expect(updated.success).toBe(true);
			expect(updated.data?.item.publishedAt).toBe(newPublishedAt);
		});

		it("leaves createdAt untouched on update", async () => {
			const originalCreated = "2019-03-15T10:30:00.000Z";
			const created = await handleContentCreate(db, "post", {
				data: { title: "Hi" },
				createdAt: originalCreated,
			});
			expect(created.success).toBe(true);

			const updated = await handleContentUpdate(db, "post", created.data!.item.id, {
				data: { title: "Edited" },
				publishedAt: "2020-01-01T00:00:00.000Z",
			});

			expect(updated.success).toBe(true);
			expect(updated.data?.item.createdAt).toBe(originalCreated);
		});
	});
});
