import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	handleContentCreate,
	handleContentGet,
	handleContentList,
	handleContentUpdate,
	handleContentDuplicate,
	handleContentPermanentDelete,
} from "../../../src/api/handlers/content.js";
import { handleSitemapData } from "../../../src/api/handlers/seo.js";
import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import type { ContentItem } from "../../../src/database/repositories/types.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { getSeoMeta, getContentSeo } from "../../../src/seo/index.js";

describe("SEO", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let seoRepo: SeoRepository;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await runMigrations(db);
		repo = new ContentRepository(db);
		seoRepo = new SeoRepository(db);
		registry = new SchemaRegistry(db);

		// Create post collection with title field and SEO enabled
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
		// Enable SEO on posts
		await db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();

		// Create page collection with SEO enabled
		await registry.createCollection({
			slug: "page",
			label: "Pages",
			labelSingular: "Page",
		});
		await registry.createField("page", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "page")
			.execute();
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("SeoRepository", () => {
		it("should return default SEO when no row exists", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			const seo = await seoRepo.get("post", content.id);
			expect(seo).toEqual({
				title: null,
				description: null,
				image: null,
				canonical: null,
				noIndex: false,
			});
		});

		it("should upsert and retrieve SEO data", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await seoRepo.upsert("post", content.id, {
				title: "Custom SEO Title",
				description: "A meta description",
				image: "media-123",
				canonical: "https://example.com/original",
				noIndex: true,
			});

			const seo = await seoRepo.get("post", content.id);
			expect(seo.title).toBe("Custom SEO Title");
			expect(seo.description).toBe("A meta description");
			expect(seo.image).toBe("media-123");
			expect(seo.canonical).toBe("https://example.com/original");
			expect(seo.noIndex).toBe(true);
		});

		it("should upsert with partial fields", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await seoRepo.upsert("post", content.id, { title: "Just a title" });

			const seo = await seoRepo.get("post", content.id);
			expect(seo.title).toBe("Just a title");
			expect(seo.description).toBeNull();
			expect(seo.image).toBeNull();
			expect(seo.canonical).toBeNull();
			expect(seo.noIndex).toBe(false);
		});

		it("should update existing SEO data", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await seoRepo.upsert("post", content.id, { title: "Original" });
			await seoRepo.upsert("post", content.id, {
				title: "Updated",
				description: "New desc",
			});

			const seo = await seoRepo.get("post", content.id);
			expect(seo.title).toBe("Updated");
			expect(seo.description).toBe("New desc");
		});

		it("should clear fields with null values", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await seoRepo.upsert("post", content.id, {
				title: "Title",
				description: "Desc",
			});

			await seoRepo.upsert("post", content.id, {
				title: null,
				description: null,
			});

			const seo = await seoRepo.get("post", content.id);
			expect(seo.title).toBeNull();
			expect(seo.description).toBeNull();
		});

		it("should delete SEO data", async () => {
			const content = await repo.create({
				type: "post",
				data: { title: "Test" },
			});

			await seoRepo.upsert("post", content.id, { title: "Title" });
			await seoRepo.delete("post", content.id);

			const seo = await seoRepo.get("post", content.id);
			expect(seo.title).toBeNull();
		});

		it("should copy SEO for duplicate without canonical", async () => {
			const original = await repo.create({
				type: "post",
				data: { title: "Original" },
			});

			await seoRepo.upsert("post", original.id, {
				title: "SEO Title",
				description: "SEO Desc",
				canonical: "https://example.com/original",
				noIndex: true,
			});

			const duplicate = await repo.create({
				type: "post",
				data: { title: "Copy" },
			});

			await seoRepo.copyForDuplicate("post", original.id, duplicate.id);

			const seo = await seoRepo.get("post", duplicate.id);
			expect(seo.title).toBe("SEO Title");
			expect(seo.description).toBe("SEO Desc");
			expect(seo.canonical).toBeNull(); // Canonical should not be copied
			expect(seo.noIndex).toBe(true);
		});

		it("should batch-get SEO for multiple content items", async () => {
			const c1 = await repo.create({ type: "post", data: { title: "Post 1" } });
			const c2 = await repo.create({ type: "post", data: { title: "Post 2" } });
			const c3 = await repo.create({ type: "post", data: { title: "Post 3" } });

			await seoRepo.upsert("post", c1.id, { title: "SEO 1" });
			await seoRepo.upsert("post", c3.id, { title: "SEO 3", noIndex: true });
			// c2 has no SEO row

			const seoMap = await seoRepo.getMany("post", [c1.id, c2.id, c3.id]);

			expect(seoMap.size).toBe(3);
			expect(seoMap.get(c1.id)!.title).toBe("SEO 1");
			expect(seoMap.get(c2.id)!.title).toBeNull(); // defaults
			expect(seoMap.get(c3.id)!.title).toBe("SEO 3");
			expect(seoMap.get(c3.id)!.noIndex).toBe(true);
		});

		it("should return empty map for getMany with no IDs", async () => {
			const seoMap = await seoRepo.getMany("post", []);
			expect(seoMap.size).toBe(0);
		});

		it("should skip upsert when input has no fields set", async () => {
			const content = await repo.create({ type: "post", data: { title: "Test" } });

			// Empty seo input should be a no-op
			const seo = await seoRepo.upsert("post", content.id, {});

			// Should return defaults without creating a row
			expect(seo.title).toBeNull();
			expect(seo.noIndex).toBe(false);

			// Verify no row was actually written
			const directCheck = await seoRepo.get("post", content.id);
			expect(directCheck.title).toBeNull();
		});

		it("should not copy SEO when source has no data", async () => {
			const original = await repo.create({
				type: "post",
				data: { title: "Original" },
			});
			const duplicate = await repo.create({
				type: "post",
				data: { title: "Copy" },
			});

			await seoRepo.copyForDuplicate("post", original.id, duplicate.id);

			// Should still return defaults (no row was created)
			const seo = await seoRepo.get("post", duplicate.id);
			expect(seo.title).toBeNull();
		});
	});

	describe("Content handlers with SEO", () => {
		it("should create content with SEO via handler", async () => {
			const result = await handleContentCreate(db, "post", {
				data: { title: "Test Post" },
				seo: {
					title: "Custom SEO Title",
					description: "A meta description",
				},
			});

			expect(result.success).toBe(true);
			const item = result.data!.item;
			expect(item.seo).toBeDefined();
			expect(item.seo!.title).toBe("Custom SEO Title");
			expect(item.seo!.description).toBe("A meta description");
		});

		it("should return default SEO for SEO-enabled collection with no SEO input", async () => {
			const result = await handleContentCreate(db, "post", {
				data: { title: "Test Post" },
			});

			expect(result.success).toBe(true);
			const item = result.data!.item;
			expect(item.seo).toBeDefined();
			expect(item.seo!.title).toBeNull();
			expect(item.seo!.noIndex).toBe(false);
		});

		it("should update SEO via content handler", async () => {
			const createResult = await handleContentCreate(db, "post", {
				data: { title: "Test Post" },
			});
			const id = createResult.data!.item.id;

			const updateResult = await handleContentUpdate(db, "post", id, {
				seo: {
					title: "Updated SEO Title",
					description: "Updated description",
					noIndex: true,
				},
			});

			expect(updateResult.success).toBe(true);
			const item = updateResult.data!.item;
			expect(item.seo!.title).toBe("Updated SEO Title");
			expect(item.seo!.description).toBe("Updated description");
			expect(item.seo!.noIndex).toBe(true);
		});

		it("should preserve SEO when updating only content data", async () => {
			const createResult = await handleContentCreate(db, "post", {
				data: { title: "Test Post" },
				seo: { title: "SEO Title", description: "SEO Description" },
			});
			const id = createResult.data!.item.id;

			// Update only content data, not SEO
			const updateResult = await handleContentUpdate(db, "post", id, {
				data: { title: "Updated Title" },
			});

			expect(updateResult.success).toBe(true);
			expect(updateResult.data!.item.seo!.title).toBe("SEO Title");
			expect(updateResult.data!.item.seo!.description).toBe("SEO Description");
		});

		it("should hydrate SEO in handleContentGet", async () => {
			const createResult = await handleContentCreate(db, "post", {
				data: { title: "Test Post" },
				seo: { title: "SEO Title" },
			});
			const id = createResult.data!.item.id;

			const getResult = await handleContentGet(db, "post", id);
			expect(getResult.success).toBe(true);
			expect(getResult.data!.item.seo!.title).toBe("SEO Title");
		});

		it("should hydrate SEO in handleContentList", async () => {
			await handleContentCreate(db, "post", {
				data: { title: "Post 1" },
				seo: { title: "SEO 1" },
			});
			await handleContentCreate(db, "post", {
				data: { title: "Post 2" },
				seo: { title: "SEO 2", noIndex: true },
			});

			const listResult = await handleContentList(db, "post", {});
			expect(listResult.success).toBe(true);
			expect(listResult.data!.items).toHaveLength(2);

			const seoTitles = listResult.data!.items.map((item) => item.seo?.title);
			expect(seoTitles).toContain("SEO 1");
			expect(seoTitles).toContain("SEO 2");

			const noIndexItem = listResult.data!.items.find((item) => item.seo?.noIndex);
			expect(noIndexItem).toBeDefined();
			expect(noIndexItem!.seo!.title).toBe("SEO 2");
		});

		it("should copy SEO when duplicating content", async () => {
			const createResult = await handleContentCreate(db, "post", {
				data: { title: "Original Post" },
				seo: {
					title: "SEO Title",
					description: "SEO Desc",
					canonical: "https://example.com/original",
				},
			});
			const id = createResult.data!.item.id;

			const dupResult = await handleContentDuplicate(db, "post", id);
			expect(dupResult.success).toBe(true);
			const dupItem = dupResult.data!.item;
			expect(dupItem.seo).toBeDefined();
			expect(dupItem.seo!.title).toBe("SEO Title");
			expect(dupItem.seo!.description).toBe("SEO Desc");
			expect(dupItem.seo!.canonical).toBeNull(); // Canonical should not be copied
		});

		it("should return default SEO on duplicate when original has no SEO customizations", async () => {
			// Create with no explicit SEO
			const createResult = await handleContentCreate(db, "post", {
				data: { title: "Plain Post" },
			});
			const id = createResult.data!.item.id;

			const dupResult = await handleContentDuplicate(db, "post", id);
			expect(dupResult.success).toBe(true);

			// Duplicate of an SEO-enabled collection should always have seo field
			const dupItem = dupResult.data!.item;
			expect(dupItem.seo).toBeDefined();
			expect(dupItem.seo!.title).toBeNull();
			expect(dupItem.seo!.noIndex).toBe(false);
		});

		it("should not include seo on duplicate of non-SEO collection", async () => {
			await registry.createCollection({
				slug: "tags",
				label: "Tags",
				labelSingular: "Tag",
			});
			await registry.createField("tags", { slug: "name", label: "Name", type: "string" });

			const createResult = await handleContentCreate(db, "tags", {
				data: { name: "TypeScript" },
			});
			expect(createResult.success).toBe(true);

			const dupResult = await handleContentDuplicate(db, "tags", createResult.data!.item.id);
			expect(dupResult.success).toBe(true);
			expect(dupResult.data!.item.seo).toBeUndefined();
		});

		it("should clean up SEO on permanent delete", async () => {
			const createResult = await handleContentCreate(db, "post", {
				data: { title: "Test Post" },
				seo: { title: "SEO Title" },
			});
			const id = createResult.data!.item.id;

			// Soft delete first, then permanent delete
			await repo.delete("post", id);
			await handleContentPermanentDelete(db, "post", id);

			// SEO row should be gone
			const seo = await seoRepo.get("post", id);
			expect(seo.title).toBeNull();
		});

		it("should clean up revisions on permanent delete", async () => {
			const createResult = await handleContentCreate(db, "post", {
				data: { title: "Test Post" },
			});
			const id = createResult.data!.item.id;

			// Create some revisions
			const revisionRepo = new RevisionRepository(db);
			await revisionRepo.create({ collection: "post", entryId: id, data: { title: "v1" } });
			await revisionRepo.create({ collection: "post", entryId: id, data: { title: "v2" } });

			const before = await revisionRepo.findByEntry("post", id);
			expect(before).toHaveLength(2);

			// Soft delete first, then permanent delete
			await repo.delete("post", id);
			await handleContentPermanentDelete(db, "post", id);

			// Revisions should be gone
			const after = await revisionRepo.findByEntry("post", id);
			expect(after).toHaveLength(0);
		});

		it("should not hydrate SEO for collections without has_seo", async () => {
			// Create a collection without SEO
			await registry.createCollection({
				slug: "snippet",
				label: "Snippets",
				labelSingular: "Snippet",
			});
			await registry.createField("snippet", {
				slug: "code",
				label: "Code",
				type: "string",
			});

			const createResult = await handleContentCreate(db, "snippet", {
				data: { code: "console.log('hi')" },
			});

			expect(createResult.success).toBe(true);
			expect(createResult.data!.item.seo).toBeUndefined();

			const getResult = await handleContentGet(db, "snippet", createResult.data!.item.id);
			expect(getResult.success).toBe(true);
			expect(getResult.data!.item.seo).toBeUndefined();
		});

		it("should return validation error for SEO input on non-SEO collections", async () => {
			await registry.createCollection({
				slug: "nav",
				label: "Nav Items",
				labelSingular: "Nav Item",
			});
			await registry.createField("nav", {
				slug: "label",
				label: "Label",
				type: "string",
			});

			// Providing seo input for a non-SEO collection should return a validation error
			const result = await handleContentCreate(db, "nav", {
				data: { label: "Home" },
				seo: { title: "Should be rejected" },
			});

			expect(result.success).toBe(false);
			expect(result.error!.code).toBe("VALIDATION_ERROR");
			expect(result.error!.message).toContain("does not have SEO enabled");
		});

		it("should return validation error for SEO input on update for non-SEO collections", async () => {
			await registry.createCollection({
				slug: "nav",
				label: "Nav Items",
				labelSingular: "Nav Item",
			});
			await registry.createField("nav", {
				slug: "label",
				label: "Label",
				type: "string",
			});

			// Create without SEO (should succeed)
			const created = await handleContentCreate(db, "nav", {
				data: { label: "Home" },
			});
			expect(created.success).toBe(true);

			// Try to update with SEO (should fail)
			const updated = await handleContentUpdate(db, "nav", created.data!.item.id, {
				data: { label: "Updated" },
				seo: { title: "Should be rejected" },
			});

			expect(updated.success).toBe(false);
			expect(updated.error!.code).toBe("VALIDATION_ERROR");
		});
	});

	describe("getSeoMeta helper", () => {
		it("should generate meta from content SEO fields", () => {
			const content = createMockContent({
				seo: {
					title: "SEO Title",
					description: "Meta desc",
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, { siteTitle: "My Blog" });

			expect(meta.title).toBe("SEO Title | My Blog");
			expect(meta.description).toBe("Meta desc");
			expect(meta.ogTitle).toBe("SEO Title");
		});

		it("should fall back to content data.title", () => {
			const content = createMockContent({
				data: { title: "Content Title" },
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, { siteTitle: "My Blog" });

			expect(meta.title).toBe("Content Title | My Blog");
			expect(meta.ogTitle).toBe("Content Title");
		});

		it("should use custom title separator", () => {
			const content = createMockContent({
				data: { title: "Page" },
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				siteTitle: "Site",
				titleSeparator: " - ",
			});

			expect(meta.title).toBe("Page - Site");
		});

		it("should build canonical from path when no explicit canonical", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				siteUrl: "https://example.com",
				path: "/posts/my-post",
			});

			expect(meta.canonical).toBe("https://example.com/posts/my-post");
		});

		it("should strip trailing slash from siteUrl in canonical", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				siteUrl: "https://example.com/",
				path: "/posts/my-post",
			});

			expect(meta.canonical).toBe("https://example.com/posts/my-post");
		});

		it("should prefix relative canonical paths with siteUrl", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: "posts/my-post",
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				siteUrl: "https://example.com",
			});

			expect(meta.canonical).toBe("https://example.com/posts/my-post");
		});

		it("should handle path without leading slash in path-based canonical", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				siteUrl: "https://example.com",
				path: "posts/my-post",
			});

			expect(meta.canonical).toBe("https://example.com/posts/my-post");
		});

		it("should prefer explicit canonical over path-based", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: "https://other.com/original",
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				siteUrl: "https://example.com",
				path: "/posts/my-post",
			});

			expect(meta.canonical).toBe("https://other.com/original");
		});

		it("should set noindex robots when noIndex is true", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: true,
				},
			});

			const meta = getSeoMeta(content);

			expect(meta.robots).toBe("noindex, nofollow");
		});

		it("should return null robots when noIndex is false", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content);

			expect(meta.robots).toBeNull();
		});

		it("should build OG image URL from media reference", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: "media-123",
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				siteUrl: "https://example.com",
			});

			expect(meta.ogImage).toBe("https://example.com/_emdash/api/media/file/media-123");
		});

		it("should pass through absolute image URLs", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: "https://cdn.example.com/image.jpg",
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content);

			expect(meta.ogImage).toBe("https://cdn.example.com/image.jpg");
		});

		it("should use defaultOgImage when content has no image", () => {
			const content = createMockContent({
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content, {
				defaultOgImage: "https://example.com/default-og.jpg",
			});

			expect(meta.ogImage).toBe("https://example.com/default-og.jpg");
		});

		it("should fall back to data.excerpt for description", () => {
			const content = createMockContent({
				data: { title: "Post", excerpt: "A brief excerpt" },
				seo: {
					title: null,
					description: null,
					image: null,
					canonical: null,
					noIndex: false,
				},
			});

			const meta = getSeoMeta(content);

			expect(meta.description).toBe("A brief excerpt");
			expect(meta.ogDescription).toBe("A brief excerpt");
		});

		it("should handle content with no SEO field (non-SEO collection)", () => {
			const content = createMockContent({});
			// Remove seo to simulate a non-SEO collection
			delete (content as Partial<ContentItem>).seo;

			const meta = getSeoMeta(content, { siteTitle: "My Blog" });

			// Should use fallback defaults
			expect(meta.title).toBe("Default Title | My Blog");
			expect(meta.description).toBeNull();
			expect(meta.robots).toBeNull();
		});
	});

	describe("getContentSeo", () => {
		it("should return the content SEO object", () => {
			const seo = {
				title: "Title",
				description: "Desc",
				image: null,
				canonical: null,
				noIndex: false,
			};
			const content = createMockContent({ seo });

			expect(getContentSeo(content)).toEqual(seo);
		});

		it("should return undefined for content without SEO", () => {
			const content = createMockContent({});
			delete (content as Partial<ContentItem>).seo;

			expect(getContentSeo(content)).toBeUndefined();
		});
	});

	describe("handleSitemapData", () => {
		/** Flatten the per-collection response into a flat list with collection tag. */
		function flatEntries(data: {
			collections: Array<{
				collection: string;
				entries: Array<{ id: string; slug: string | null; updatedAt: string }>;
			}>;
		}) {
			return data.collections.flatMap((c) =>
				c.entries.map((e) => ({ collection: c.collection, ...e })),
			);
		}

		it("should return published content from SEO-enabled collections", async () => {
			await repo.create({
				type: "post",
				slug: "published-post",
				data: { title: "Published" },
				status: "published",
			});

			await repo.create({
				type: "post",
				slug: "draft-post",
				data: { title: "Draft" },
				status: "draft",
			});

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			const entries = flatEntries(result.data!);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.collection).toBe("post");
			expect(entries[0]!.slug).toBe("published-post");
		});

		it("should exclude noindex content from sitemap", async () => {
			await repo.create({
				type: "post",
				slug: "visible-post",
				data: { title: "Visible" },
				status: "published",
			});

			const hidden = await repo.create({
				type: "post",
				slug: "hidden-post",
				data: { title: "Hidden" },
				status: "published",
			});

			// Mark hidden post as noindex via SeoRepository
			await seoRepo.upsert("post", hidden.id, { noIndex: true });

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			const entries = flatEntries(result.data!);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.slug).toBe("visible-post");
		});

		it("should exclude deleted content from sitemap", async () => {
			const created = await repo.create({
				type: "post",
				slug: "deleted-post",
				data: { title: "Deleted" },
				status: "published",
			});

			await repo.delete("post", created.id);

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			const entries = flatEntries(result.data!);
			expect(entries).toHaveLength(0);
		});

		it("should include content from multiple SEO-enabled collections", async () => {
			await repo.create({
				type: "post",
				slug: "my-post",
				data: { title: "A Post" },
				status: "published",
			});

			await repo.create({
				type: "page",
				slug: "about",
				data: { title: "About Us" },
				status: "published",
			});

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			expect(result.data!.collections).toHaveLength(2);

			const entries = flatEntries(result.data!);
			const slugs = entries.map((e) => `${e.collection}/${e.slug}`);
			expect(slugs).toContain("post/my-post");
			expect(slugs).toContain("page/about");
		});

		it("should exclude content from non-SEO collections", async () => {
			// Create a collection WITHOUT has_seo
			await registry.createCollection({
				slug: "snippet",
				label: "Snippets",
				labelSingular: "Snippet",
			});
			await registry.createField("snippet", {
				slug: "code",
				label: "Code",
				type: "string",
			});

			await repo.create({
				type: "post",
				slug: "my-post",
				data: { title: "A Post" },
				status: "published",
			});

			await repo.create({
				type: "snippet",
				slug: "my-snippet",
				data: { code: "hello" },
				status: "published",
			});

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			expect(result.data!.collections).toHaveLength(1);
			expect(result.data!.collections[0]!.collection).toBe("post");
		});

		it("should return null slug and valid id when slug is null", async () => {
			const created = await repo.create({
				type: "post",
				data: { title: "No Slug Post" },
				status: "published",
			});

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			const entries = flatEntries(result.data!);
			expect(entries[0]!.collection).toBe("post");
			expect(entries[0]!.slug).toBeNull();
			expect(entries[0]!.id).toBe(created.id);
		});

		it("should include updatedAt and lastmod", async () => {
			await repo.create({
				type: "post",
				slug: "test",
				data: { title: "Test" },
				status: "published",
			});

			const result = await handleSitemapData(db);

			const col = result.data!.collections[0]!;
			expect(col.lastmod).toBeDefined();
			expect(new Date(col.lastmod).getTime()).not.toBeNaN();
			expect(col.entries[0]!.updatedAt).toBeDefined();
			expect(new Date(col.entries[0]!.updatedAt).getTime()).not.toBeNaN();
		});

		it("should include urlPattern from collection", async () => {
			await db
				.updateTable("_emdash_collections")
				.set({ url_pattern: "/blog/{slug}" })
				.where("slug", "=", "post")
				.execute();

			await repo.create({
				type: "post",
				slug: "test",
				data: { title: "Test" },
				status: "published",
			});

			const result = await handleSitemapData(db);

			expect(result.data!.collections[0]!.urlPattern).toBe("/blog/{slug}");
		});

		it("should filter by collection when collectionSlug is provided", async () => {
			await repo.create({
				type: "post",
				slug: "my-post",
				data: { title: "A Post" },
				status: "published",
			});

			await repo.create({
				type: "page",
				slug: "about",
				data: { title: "About Us" },
				status: "published",
			});

			const result = await handleSitemapData(db, "post");

			expect(result.success).toBe(true);
			expect(result.data!.collections).toHaveLength(1);
			expect(result.data!.collections[0]!.collection).toBe("post");
		});

		it("should return empty collections when no SEO-enabled collections exist", async () => {
			// Disable SEO on all collections
			await db.updateTable("_emdash_collections").set({ has_seo: 0 }).execute();

			await repo.create({
				type: "post",
				slug: "test",
				data: { title: "Test" },
				status: "published",
			});

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			expect(result.data!.collections).toEqual([]);
		});

		it("should return empty collections for empty database", async () => {
			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			expect(result.data!.collections).toEqual([]);
		});

		it("should include locale on each entry (defaults to 'en')", async () => {
			await repo.create({
				type: "post",
				slug: "english-post",
				data: { title: "English" },
				status: "published",
			});

			const result = await handleSitemapData(db);

			expect(result.success).toBe(true);
			const entry = result.data!.collections[0]!.entries[0]!;
			expect(entry.locale).toBe("en");
		});

		it("should return locale for each translated row of a collection", async () => {
			const en = await repo.create({
				type: "post",
				slug: "about",
				data: { title: "About" },
				status: "published",
				locale: "en",
			});

			await repo.create({
				type: "post",
				slug: "a-propos",
				data: { title: "À propos" },
				status: "published",
				locale: "fr",
				translationOf: en.id,
			});

			const result = await handleSitemapData(db, "post");

			expect(result.success).toBe(true);
			const entries = result.data!.collections[0]!.entries;
			const bySlug = new Map(entries.map((e) => [e.slug, e.locale]));
			expect(bySlug.get("about")).toBe("en");
			expect(bySlug.get("a-propos")).toBe("fr");
		});
	});

	describe("has_seo opt-in per collection", () => {
		it("should default has_seo to 0 for new collections", async () => {
			await registry.createCollection({
				slug: "article",
				label: "Articles",
				labelSingular: "Article",
			});

			const row = await db
				.selectFrom("_emdash_collections")
				.select("has_seo")
				.where("slug", "=", "article")
				.executeTakeFirst();

			expect(row!.has_seo).toBe(0);
		});

		it("should allow enabling has_seo on existing collections", async () => {
			await registry.createCollection({
				slug: "article",
				label: "Articles",
				labelSingular: "Article",
			});

			await db
				.updateTable("_emdash_collections")
				.set({ has_seo: 1 })
				.where("slug", "=", "article")
				.execute();

			const row = await db
				.selectFrom("_emdash_collections")
				.select("has_seo")
				.where("slug", "=", "article")
				.executeTakeFirst();

			expect(row!.has_seo).toBe(1);
		});
	});
});

/**
 * Helper to create a mock ContentItem for unit-level getSeoMeta tests.
 */
function createMockContent(
	overrides: Partial<{
		data: Record<string, unknown>;
		seo: {
			title: string | null;
			description: string | null;
			image: string | null;
			canonical: string | null;
			noIndex: boolean;
		};
	}> = {},
): ContentItem {
	return {
		id: "test-id",
		type: "post",
		slug: "test-post",
		status: "published",
		data: overrides.data ?? { title: "Default Title" },
		authorId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		publishedAt: "2025-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		version: 1,
		seo: overrides.seo ?? {
			title: null,
			description: null,
			image: null,
			canonical: null,
			noIndex: false,
		},
	};
}
