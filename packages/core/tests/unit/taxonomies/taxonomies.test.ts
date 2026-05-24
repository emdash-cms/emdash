import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import {
	setupTestDatabase,
	setupTestDatabaseWithCollections,
	teardownTestDatabase,
} from "../../utils/test-db.js";

describe("taxonomy manifest loading", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("should load seeded taxonomy definitions ordered by name", async () => {
		const rows = await db.selectFrom("_emdash_taxonomy_defs").selectAll().orderBy("name").execute();

		const taxonomies = rows.map((row) => ({
			name: row.name,
			label: row.label,
			labelSingular: row.label_singular ?? undefined,
			hierarchical: row.hierarchical === 1,
			collections: row.collections ? JSON.parse(row.collections) : [],
		}));

		expect(taxonomies).toHaveLength(2);
		expect(taxonomies[0]).toMatchObject({
			name: "category",
			label: "Categories",
			hierarchical: true,
			collections: ["posts"],
		});
		expect(taxonomies[1]).toMatchObject({
			name: "tag",
			label: "Tags",
			hierarchical: false,
			collections: ["posts"],
		});
	});

	it("should include custom taxonomy definitions in manifest", async () => {
		await db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: "taxdef_genre",
				name: "genre",
				label: "Genres",
				label_singular: "Genre",
				hierarchical: 1,
				collections: JSON.stringify(["posts", "pages"]),
			})
			.execute();

		const rows = await db.selectFrom("_emdash_taxonomy_defs").selectAll().orderBy("name").execute();

		const taxonomies = rows.map((row) => ({
			name: row.name,
			label: row.label,
			labelSingular: row.label_singular ?? undefined,
			hierarchical: row.hierarchical === 1,
			collections: row.collections ? JSON.parse(row.collections) : [],
		}));

		expect(taxonomies).toHaveLength(3);
		expect(taxonomies[0].name).toBe("category");
		expect(taxonomies[1].name).toBe("genre");
		expect(taxonomies[2].name).toBe("tag");
		expect(taxonomies[1]).toMatchObject({
			label: "Genres",
			hierarchical: true,
			collections: ["posts", "pages"],
		});
	});
});

describe("TaxonomyRepository", () => {
	let db: Kysely<Database>;
	let repo: TaxonomyRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new TaxonomyRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("create", () => {
		it("should create a taxonomy term", async () => {
			const term = await repo.create({
				name: "tags",
				slug: "javascript",
				label: "JavaScript",
			});

			expect(term.id).toBeDefined();
			expect(term.name).toBe("tags");
			expect(term.slug).toBe("javascript");
			expect(term.label).toBe("JavaScript");
			expect(term.parentId).toBeNull();
		});

		it("should create a term with parent", async () => {
			const parent = await repo.create({
				name: "category",
				slug: "tech",
				label: "Technology",
			});

			const child = await repo.create({
				name: "category",
				slug: "web",
				label: "Web Development",
				parentId: parent.id,
			});

			expect(child.parentId).toBe(parent.id);
		});

		it("should create a term with data", async () => {
			const term = await repo.create({
				name: "category",
				slug: "tech",
				label: "Technology",
				data: { description: "All things tech", color: "#0066cc" },
			});

			expect(term.data).toEqual({
				description: "All things tech",
				color: "#0066cc",
			});
		});
	});

	describe("findById", () => {
		it("should find term by ID", async () => {
			const created = await repo.create({
				name: "tags",
				slug: "test",
				label: "Test",
			});

			const found = await repo.findById(created.id);

			expect(found).not.toBeNull();
			expect(found?.id).toBe(created.id);
		});

		it("should return null for non-existent ID", async () => {
			const found = await repo.findById("non-existent");
			expect(found).toBeNull();
		});
	});

	describe("findBySlug", () => {
		it("should find term by name and slug", async () => {
			await repo.create({
				name: "tags",
				slug: "javascript",
				label: "JavaScript",
			});

			const found = await repo.findBySlug("tags", "javascript");

			expect(found).not.toBeNull();
			expect(found?.label).toBe("JavaScript");
		});

		it("should not find term with wrong name", async () => {
			await repo.create({
				name: "tags",
				slug: "javascript",
				label: "JavaScript",
			});

			// Same slug, different name
			const found = await repo.findBySlug("category", "javascript");
			expect(found).toBeNull();
		});

		it("should return null for non-existent slug", async () => {
			const found = await repo.findBySlug("tags", "non-existent");
			expect(found).toBeNull();
		});
	});

	describe("findByName", () => {
		it("should find all terms for a taxonomy", async () => {
			await repo.create({ name: "tags", slug: "js", label: "JavaScript" });
			await repo.create({ name: "tags", slug: "ts", label: "TypeScript" });
			await repo.create({ name: "category", slug: "tech", label: "Tech" });

			const tags = await repo.findByName("tags");

			expect(tags).toHaveLength(2);
			expect(tags.map((t) => t.slug)).toContain("js");
			expect(tags.map((t) => t.slug)).toContain("ts");
		});

		it("should filter by parentId", async () => {
			const parent = await repo.create({
				name: "category",
				slug: "tech",
				label: "Technology",
			});
			await repo.create({
				name: "category",
				slug: "web",
				label: "Web",
				parentId: parent.id,
			});
			await repo.create({
				name: "category",
				slug: "mobile",
				label: "Mobile",
				parentId: parent.id,
			});
			await repo.create({
				name: "category",
				slug: "design",
				label: "Design",
			});

			const children = await repo.findByName("category", {
				parentId: parent.id,
			});
			expect(children).toHaveLength(2);

			const roots = await repo.findByName("category", { parentId: null });
			expect(roots).toHaveLength(2); // tech and design
		});

		it("should return terms ordered by label", async () => {
			await repo.create({ name: "tags", slug: "z", label: "Zebra" });
			await repo.create({ name: "tags", slug: "a", label: "Apple" });
			await repo.create({ name: "tags", slug: "m", label: "Mango" });

			const tags = await repo.findByName("tags");

			expect(tags[0].label).toBe("Apple");
			expect(tags[1].label).toBe("Mango");
			expect(tags[2].label).toBe("Zebra");
		});
	});

	describe("findChildren", () => {
		it("should find children of a term", async () => {
			const parent = await repo.create({
				name: "category",
				slug: "tech",
				label: "Technology",
			});
			await repo.create({
				name: "category",
				slug: "web",
				label: "Web",
				parentId: parent.id,
			});
			await repo.create({
				name: "category",
				slug: "mobile",
				label: "Mobile",
				parentId: parent.id,
			});

			const children = await repo.findChildren(parent.id);

			expect(children).toHaveLength(2);
		});

		it("should return empty array for term with no children", async () => {
			const term = await repo.create({
				name: "tags",
				slug: "test",
				label: "Test",
			});

			const children = await repo.findChildren(term.id);
			expect(children).toHaveLength(0);
		});
	});

	describe("update", () => {
		it("should update term label", async () => {
			const term = await repo.create({
				name: "tags",
				slug: "js",
				label: "JavaScript",
			});

			const updated = await repo.update(term.id, { label: "JS" });

			expect(updated?.label).toBe("JS");
			expect(updated?.slug).toBe("js"); // unchanged
		});

		it("should update term slug", async () => {
			const term = await repo.create({
				name: "tags",
				slug: "js",
				label: "JavaScript",
			});

			const updated = await repo.update(term.id, { slug: "javascript" });

			expect(updated?.slug).toBe("javascript");
		});

		it("should update parentId", async () => {
			const parent = await repo.create({
				name: "category",
				slug: "tech",
				label: "Tech",
			});
			const orphan = await repo.create({
				name: "category",
				slug: "web",
				label: "Web",
			});

			const updated = await repo.update(orphan.id, { parentId: parent.id });

			expect(updated?.parentId).toBe(parent.id);
		});

		it("should clear parentId when set to null", async () => {
			const parent = await repo.create({
				name: "category",
				slug: "tech",
				label: "Tech",
			});
			const child = await repo.create({
				name: "category",
				slug: "web",
				label: "Web",
				parentId: parent.id,
			});

			const updated = await repo.update(child.id, { parentId: null });

			expect(updated?.parentId).toBeNull();
		});

		it("should update data", async () => {
			const term = await repo.create({
				name: "category",
				slug: "tech",
				label: "Tech",
				data: { color: "blue" },
			});

			const updated = await repo.update(term.id, {
				data: { color: "red", icon: "star" },
			});

			expect(updated?.data).toEqual({ color: "red", icon: "star" });
		});

		it("should return null for non-existent term", async () => {
			const updated = await repo.update("non-existent", { label: "Test" });
			expect(updated).toBeNull();
		});
	});

	describe("delete", () => {
		it("should delete a term", async () => {
			const term = await repo.create({
				name: "tags",
				slug: "test",
				label: "Test",
			});

			const deleted = await repo.delete(term.id);

			expect(deleted).toBe(true);
			expect(await repo.findById(term.id)).toBeNull();
		});

		it("should return false for non-existent term", async () => {
			const deleted = await repo.delete("non-existent");
			expect(deleted).toBe(false);
		});

		it("should remove content associations when deleted", async () => {
			// Setup: need a collection with content
			db = await setupTestDatabaseWithCollections();
			repo = new TaxonomyRepository(db);
			const contentRepo = new ContentRepository(db);

			const term = await repo.create({
				name: "tags",
				slug: "test",
				label: "Test",
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "test-post",
				data: { title: "Test" },
			});

			await repo.attachToEntry("post", content.id, term.id);

			// Verify attached
			const termsBefore = await repo.getTermsForEntry("post", content.id);
			expect(termsBefore).toHaveLength(1);

			// Delete term
			await repo.delete(term.id);

			// Verify association removed
			const termsAfter = await repo.getTermsForEntry("post", content.id);
			expect(termsAfter).toHaveLength(0);
		});
	});

	describe("content-taxonomy junction", () => {
		let contentRepo: ContentRepository;
		let contentId: string;

		beforeEach(async () => {
			// Need collections for content
			db = await setupTestDatabaseWithCollections();
			repo = new TaxonomyRepository(db);
			contentRepo = new ContentRepository(db);

			const content = await contentRepo.create({
				type: "post",
				slug: "test-post",
				data: { title: "Test Post" },
			});
			contentId = content.id;
		});

		describe("attachToEntry", () => {
			it("should attach a term to content", async () => {
				const term = await repo.create({
					name: "tags",
					slug: "test",
					label: "Test",
				});

				await repo.attachToEntry("post", contentId, term.id);

				const terms = await repo.getTermsForEntry("post", contentId);
				expect(terms).toHaveLength(1);
				expect(terms[0].id).toBe(term.id);
			});

			it("should be idempotent (no duplicate attachments)", async () => {
				const term = await repo.create({
					name: "tags",
					slug: "test",
					label: "Test",
				});

				await repo.attachToEntry("post", contentId, term.id);
				await repo.attachToEntry("post", contentId, term.id);
				await repo.attachToEntry("post", contentId, term.id);

				const terms = await repo.getTermsForEntry("post", contentId);
				expect(terms).toHaveLength(1);
			});
		});

		describe("detachFromEntry", () => {
			it("should detach a term from content", async () => {
				const term = await repo.create({
					name: "tags",
					slug: "test",
					label: "Test",
				});

				await repo.attachToEntry("post", contentId, term.id);
				await repo.detachFromEntry("post", contentId, term.id);

				const terms = await repo.getTermsForEntry("post", contentId);
				expect(terms).toHaveLength(0);
			});

			it("should not throw when detaching non-attached term", async () => {
				const term = await repo.create({
					name: "tags",
					slug: "test",
					label: "Test",
				});

				// Should not throw
				await expect(repo.detachFromEntry("post", contentId, term.id)).resolves.toBeUndefined();
			});
		});

		describe("getTermsForEntry", () => {
			it("should get all terms for an entry", async () => {
				const tag1 = await repo.create({
					name: "tags",
					slug: "js",
					label: "JavaScript",
				});
				const tag2 = await repo.create({
					name: "tags",
					slug: "ts",
					label: "TypeScript",
				});
				const cat = await repo.create({
					name: "category",
					slug: "tech",
					label: "Tech",
				});

				await repo.attachToEntry("post", contentId, tag1.id);
				await repo.attachToEntry("post", contentId, tag2.id);
				await repo.attachToEntry("post", contentId, cat.id);

				const allTerms = await repo.getTermsForEntry("post", contentId);
				expect(allTerms).toHaveLength(3);
			});

			it("should filter by taxonomy name", async () => {
				const tag = await repo.create({
					name: "tags",
					slug: "js",
					label: "JavaScript",
				});
				const cat = await repo.create({
					name: "category",
					slug: "tech",
					label: "Tech",
				});

				await repo.attachToEntry("post", contentId, tag.id);
				await repo.attachToEntry("post", contentId, cat.id);

				const tags = await repo.getTermsForEntry("post", contentId, "tags");
				expect(tags).toHaveLength(1);
				expect(tags[0].slug).toBe("js");

				const categories = await repo.getTermsForEntry("post", contentId, "category");
				expect(categories).toHaveLength(1);
				expect(categories[0].slug).toBe("tech");
			});
		});

		describe("setTermsForEntry", () => {
			it("should replace all terms for a taxonomy", async () => {
				const tag1 = await repo.create({
					name: "tags",
					slug: "js",
					label: "JavaScript",
				});
				const tag2 = await repo.create({
					name: "tags",
					slug: "ts",
					label: "TypeScript",
				});
				const tag3 = await repo.create({
					name: "tags",
					slug: "rust",
					label: "Rust",
				});

				// Initial state: js and ts
				await repo.attachToEntry("post", contentId, tag1.id);
				await repo.attachToEntry("post", contentId, tag2.id);

				// Set to: ts and rust (removes js, keeps ts, adds rust)
				await repo.setTermsForEntry("post", contentId, "tags", [tag2.id, tag3.id]);

				const terms = await repo.getTermsForEntry("post", contentId, "tags");
				expect(terms).toHaveLength(2);
				expect(terms.map((t) => t.slug).toSorted()).toEqual(["rust", "ts"]);
			});

			it("should not affect other taxonomies", async () => {
				const tag = await repo.create({
					name: "tags",
					slug: "js",
					label: "JavaScript",
				});
				const cat = await repo.create({
					name: "category",
					slug: "tech",
					label: "Tech",
				});

				await repo.attachToEntry("post", contentId, tag.id);
				await repo.attachToEntry("post", contentId, cat.id);

				// Clear tags but keep categories
				await repo.setTermsForEntry("post", contentId, "tags", []);

				const tags = await repo.getTermsForEntry("post", contentId, "tags");
				expect(tags).toHaveLength(0);

				const categories = await repo.getTermsForEntry("post", contentId, "category");
				expect(categories).toHaveLength(1);
			});
		});

		describe("clearEntryTerms", () => {
			it("should remove all terms from an entry", async () => {
				const tag = await repo.create({
					name: "tags",
					slug: "js",
					label: "JavaScript",
				});
				const cat = await repo.create({
					name: "category",
					slug: "tech",
					label: "Tech",
				});

				await repo.attachToEntry("post", contentId, tag.id);
				await repo.attachToEntry("post", contentId, cat.id);

				const count = await repo.clearEntryTerms("post", contentId);

				expect(count).toBe(2);

				const terms = await repo.getTermsForEntry("post", contentId);
				expect(terms).toHaveLength(0);
			});
		});

		describe("countEntriesWithTerm", () => {
			it("should count entries with a term", async () => {
				const tag = await repo.create({
					name: "tags",
					slug: "js",
					label: "JavaScript",
				});

				// Create more posts
				const post2 = await contentRepo.create({
					type: "post",
					slug: "post-2",
					data: { title: "Post 2" },
				});
				await contentRepo.create({
					type: "post",
					slug: "post-3",
					data: { title: "Post 3" },
				});

				await repo.attachToEntry("post", contentId, tag.id);
				await repo.attachToEntry("post", post2.id, tag.id);
				// post3 doesn't have the tag

				const count = await repo.countEntriesWithTerm(tag.id);
				expect(count).toBe(2);
			});

			it("should return 0 for unused term", async () => {
				const tag = await repo.create({
					name: "tags",
					slug: "unused",
					label: "Unused",
				});

				const count = await repo.countEntriesWithTerm(tag.id);
				expect(count).toBe(0);
			});
		});
	});
});
