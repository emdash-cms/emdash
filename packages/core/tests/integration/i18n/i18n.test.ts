import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { validateSeed } from "../../../src/seed/validate.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("i18n (Integration)", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// ─── 1. Migration — i18n columns exist ──────────────────────────

	describe("Migration — i18n columns", () => {
		it("should have locale and translation_group columns on content tables", async () => {
			const result = await sql<{ name: string }>`
				PRAGMA table_info(ec_post)
			`.execute(db);

			const columnNames = result.rows.map((r) => r.name);
			expect(columnNames).toContain("locale");
			expect(columnNames).toContain("translation_group");
		});

		it("should default locale to 'en'", async () => {
			const result = await sql<{ name: string; dflt_value: string | null }>`
				PRAGMA table_info(ec_post)
			`.execute(db);

			const localeCol = result.rows.find((r) => r.name === "locale");
			expect(localeCol).toBeDefined();
			expect(localeCol!.dflt_value).toBe("'en'");
		});

		it("should have translatable column on _emdash_fields", async () => {
			const result = await sql<{ name: string }>`
				PRAGMA table_info(_emdash_fields)
			`.execute(db);

			const columnNames = result.rows.map((r) => r.name);
			expect(columnNames).toContain("translatable");
		});

		it("should have compound unique constraint on slug+locale", async () => {
			// Insert same slug, different locale — should succeed
			await sql`
				INSERT INTO ec_post (id, slug, locale, translation_group, status, version, created_at, updated_at)
				VALUES ('id1', 'hello', 'en', 'id1', 'draft', 1, datetime('now'), datetime('now'))
			`.execute(db);

			await sql`
				INSERT INTO ec_post (id, slug, locale, translation_group, status, version, created_at, updated_at)
				VALUES ('id2', 'hello', 'fr', 'id1', 'draft', 1, datetime('now'), datetime('now'))
			`.execute(db);

			// Same slug, same locale — should fail
			await expect(
				sql`
					INSERT INTO ec_post (id, slug, locale, translation_group, status, version, created_at, updated_at)
					VALUES ('id3', 'hello', 'en', 'id3', 'draft', 1, datetime('now'), datetime('now'))
				`.execute(db),
			).rejects.toThrow();
		});

		it("should have locale and translation_group indexes", async () => {
			const result = await sql<{ name: string }>`
				PRAGMA index_list(ec_post)
			`.execute(db);

			const indexNames = result.rows.map((r) => r.name);
			expect(indexNames).toContain("idx_ec_post_locale");
			expect(indexNames).toContain("idx_ec_post_translation_group");
		});
	});

	// ─── 2. ContentRepository — locale-aware CRUD ───────────────────

	describe("ContentRepository — locale-aware CRUD", () => {
		it("create() without locale defaults to 'en'", async () => {
			const post = await repo.create(createPostFixture());
			expect(post.locale).toBe("en");
		});

		it("create() with explicit locale stores it", async () => {
			const post = await repo.create(createPostFixture({ locale: "fr", slug: "bonjour" }));
			expect(post.locale).toBe("fr");
		});

		it("create() with translationOf links via translation_group", async () => {
			const enPost = await repo.create(createPostFixture({ slug: "hello-world", locale: "en" }));

			const frPost = await repo.create(
				createPostFixture({
					slug: "bonjour-monde",
					locale: "fr",
					translationOf: enPost.id,
					data: { title: "Bonjour le Monde" },
				}),
			);

			// Both should share the same translation_group
			expect(frPost.translationGroup).toBe(enPost.translationGroup);
			// The group should be the original item's id (since it was first)
			expect(enPost.translationGroup).toBe(enPost.id);
		});

		it("create() with translationOf on a chained translation uses the root group", async () => {
			const enPost = await repo.create(createPostFixture({ slug: "hello", locale: "en" }));

			const frPost = await repo.create(
				createPostFixture({
					slug: "bonjour",
					locale: "fr",
					translationOf: enPost.id,
					data: { title: "Bonjour" },
				}),
			);

			// Create a third translation linked to the French version
			const dePost = await repo.create(
				createPostFixture({
					slug: "hallo",
					locale: "de",
					translationOf: frPost.id,
					data: { title: "Hallo" },
				}),
			);

			// All three should share the same translation_group
			expect(dePost.translationGroup).toBe(enPost.id);
			expect(frPost.translationGroup).toBe(enPost.id);
		});

		it("create() with translationOf pointing to non-existent ID throws", async () => {
			await expect(
				repo.create(
					createPostFixture({
						slug: "orphan",
						locale: "fr",
						translationOf: "NONEXISTENT_ID_12345678",
					}),
				),
			).rejects.toThrow("Translation source content not found");
		});

		it("same slug different locales are allowed", async () => {
			const en = await repo.create(createPostFixture({ slug: "about", locale: "en" }));
			const fr = await repo.create(
				createPostFixture({
					slug: "about",
					locale: "fr",
					data: { title: "À propos" },
				}),
			);

			expect(en.slug).toBe("about");
			expect(fr.slug).toBe("about");
			expect(en.id).not.toBe(fr.id);
		});

		it("same slug same locale is rejected", async () => {
			await repo.create(createPostFixture({ slug: "unique-slug", locale: "en" }));

			await expect(
				repo.create(
					createPostFixture({
						slug: "unique-slug",
						locale: "en",
						data: { title: "Duplicate" },
					}),
				),
			).rejects.toThrow();
		});

		// ── findBySlug ────────────────────────────────────────────────

		it("findBySlug() without locale returns any match", async () => {
			await repo.create(createPostFixture({ slug: "shared-slug", locale: "en" }));
			await repo.create(
				createPostFixture({
					slug: "shared-slug",
					locale: "fr",
					data: { title: "Version FR" },
				}),
			);

			const found = await repo.findBySlug("post", "shared-slug");
			expect(found).not.toBeNull();
			expect(found!.slug).toBe("shared-slug");
		});

		it("findBySlug() with locale filters to that locale", async () => {
			await repo.create(createPostFixture({ slug: "about", locale: "en" }));
			await repo.create(
				createPostFixture({
					slug: "about",
					locale: "fr",
					data: { title: "À propos" },
				}),
			);

			const en = await repo.findBySlug("post", "about", "en");
			expect(en).not.toBeNull();
			expect(en!.locale).toBe("en");

			const fr = await repo.findBySlug("post", "about", "fr");
			expect(fr).not.toBeNull();
			expect(fr!.locale).toBe("fr");

			const de = await repo.findBySlug("post", "about", "de");
			expect(de).toBeNull();
		});

		// ── findByIdOrSlug ────────────────────────────────────────────

		it("findByIdOrSlug() — ID lookup ignores locale param", async () => {
			const post = await repo.create(createPostFixture({ slug: "test-post", locale: "en" }));

			// ID lookup should find it regardless of locale param
			const found = await repo.findByIdOrSlug("post", post.id, "fr");
			expect(found).not.toBeNull();
			expect(found!.id).toBe(post.id);
			expect(found!.locale).toBe("en");
		});

		it("findByIdOrSlug() — slug lookup respects locale", async () => {
			const enPost = await repo.create(createPostFixture({ slug: "test", locale: "en" }));
			const frPost = await repo.create(
				createPostFixture({
					slug: "test",
					locale: "fr",
					data: { title: "Test FR" },
				}),
			);

			const foundEn = await repo.findByIdOrSlug("post", "test", "en");
			expect(foundEn).not.toBeNull();
			expect(foundEn!.id).toBe(enPost.id);

			const foundFr = await repo.findByIdOrSlug("post", "test", "fr");
			expect(foundFr).not.toBeNull();
			expect(foundFr!.id).toBe(frPost.id);
		});

		// ── findMany ──────────────────────────────────────────────────

		it("findMany() without locale returns all locales", async () => {
			await repo.create(createPostFixture({ slug: "en-post", locale: "en" }));
			await repo.create(
				createPostFixture({
					slug: "fr-post",
					locale: "fr",
					data: { title: "Post FR" },
				}),
			);
			await repo.create(
				createPostFixture({
					slug: "de-post",
					locale: "de",
					data: { title: "Post DE" },
				}),
			);

			const result = await repo.findMany("post");
			expect(result.items).toHaveLength(3);
		});

		it("findMany() with locale filters to that locale", async () => {
			await repo.create(createPostFixture({ slug: "en-post", locale: "en" }));
			await repo.create(
				createPostFixture({
					slug: "fr-post",
					locale: "fr",
					data: { title: "Post FR" },
				}),
			);
			await repo.create(
				createPostFixture({
					slug: "de-post",
					locale: "de",
					data: { title: "Post DE" },
				}),
			);

			const frResult = await repo.findMany("post", {
				where: { locale: "fr" },
			});
			expect(frResult.items).toHaveLength(1);
			expect(frResult.items[0]!.locale).toBe("fr");
		});

		// ── count ─────────────────────────────────────────────────────

		it("count() without locale counts all", async () => {
			await repo.create(createPostFixture({ slug: "post-en", locale: "en" }));
			await repo.create(
				createPostFixture({
					slug: "post-fr",
					locale: "fr",
					data: { title: "FR" },
				}),
			);

			const total = await repo.count("post");
			expect(total).toBe(2);
		});

		it("count() with locale counts only that locale", async () => {
			await repo.create(createPostFixture({ slug: "post-en", locale: "en" }));
			await repo.create(
				createPostFixture({
					slug: "post-fr",
					locale: "fr",
					data: { title: "FR" },
				}),
			);

			const enCount = await repo.count("post", { locale: "en" });
			expect(enCount).toBe(1);

			const deCount = await repo.count("post", { locale: "de" });
			expect(deCount).toBe(0);
		});

		// ── findTranslations ──────────────────────────────────────────

		it("findTranslations() returns all locales for a translation group", async () => {
			const enPost = await repo.create(createPostFixture({ slug: "hello", locale: "en" }));

			await repo.create(
				createPostFixture({
					slug: "bonjour",
					locale: "fr",
					translationOf: enPost.id,
					data: { title: "Bonjour" },
				}),
			);

			await repo.create(
				createPostFixture({
					slug: "hallo",
					locale: "de",
					translationOf: enPost.id,
					data: { title: "Hallo" },
				}),
			);

			const translations = await repo.findTranslations("post", enPost.translationGroup!);

			expect(translations).toHaveLength(3);

			const locales = translations
				.map((t) => t.locale)
				.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
			expect(locales).toEqual(["de", "en", "fr"]);
		});

		it("findTranslations() returns only non-deleted items", async () => {
			const enPost = await repo.create(createPostFixture({ slug: "hello", locale: "en" }));

			const frPost = await repo.create(
				createPostFixture({
					slug: "bonjour",
					locale: "fr",
					translationOf: enPost.id,
					data: { title: "Bonjour" },
				}),
			);

			// Soft-delete the French translation
			await repo.delete("post", frPost.id);

			const translations = await repo.findTranslations("post", enPost.translationGroup!);

			expect(translations).toHaveLength(1);
			expect(translations[0]!.locale).toBe("en");
		});
	});

	// ─── 3. FTS — locale-aware search ───────────────────────────────

	describe("FTS — locale-aware search", () => {
		let registry: SchemaRegistry;
		let ftsManager: FTSManager;

		beforeEach(async () => {
			registry = new SchemaRegistry(db);
			ftsManager = new FTSManager(db);

			// Mark title as searchable and enable FTS
			await registry.updateField("post", "title", { searchable: true });
			await ftsManager.enableSearch("post");
		});

		it("search with locale filter returns only that locale's results", async () => {
			// Create published posts in different locales
			const enPost = await repo.create(
				createPostFixture({
					slug: "hello-world",
					locale: "en",
					status: "published",
					data: { title: "Hello World" },
				}),
			);

			const frPost = await repo.create(
				createPostFixture({
					slug: "bonjour-monde",
					locale: "fr",
					status: "published",
					data: { title: "Bonjour le Monde" },
				}),
			);

			// Search for "world" — English only
			const enResults = await searchWithDb(db, "Hello", {
				collections: ["post"],
				locale: "en",
				status: "published",
			});

			expect(enResults.items.length).toBeGreaterThanOrEqual(1);
			expect(enResults.items.every((r) => r.locale === "en")).toBe(true);
			expect(enResults.items.some((r) => r.id === enPost.id)).toBe(true);

			// Search for "Bonjour" — French only
			const frResults = await searchWithDb(db, "Bonjour", {
				collections: ["post"],
				locale: "fr",
				status: "published",
			});

			expect(frResults.items.length).toBeGreaterThanOrEqual(1);
			expect(frResults.items.every((r) => r.locale === "fr")).toBe(true);
			expect(frResults.items.some((r) => r.id === frPost.id)).toBe(true);
		});

		it("search without locale returns results from all locales", async () => {
			await repo.create(
				createPostFixture({
					slug: "universal-en",
					locale: "en",
					status: "published",
					data: { title: "Universal Content" },
				}),
			);

			await repo.create(
				createPostFixture({
					slug: "universal-fr",
					locale: "fr",
					status: "published",
					data: { title: "Universal Contenu" },
				}),
			);

			const results = await searchWithDb(db, "Universal", {
				collections: ["post"],
				status: "published",
			});

			expect(results.items).toHaveLength(2);
			const locales = results.items.map((r) => r.locale).toSorted();
			expect(locales).toEqual(["en", "fr"]);
		});

		it("FTS index includes locale column", async () => {
			// Verify the FTS table has the locale column by checking structure
			const exists = await ftsManager.ftsTableExists("post");
			expect(exists).toBe(true);

			// Create a post and verify it appears in FTS results with locale
			await repo.create(
				createPostFixture({
					slug: "fts-test",
					locale: "ja",
					status: "published",
					data: { title: "FTS Locale Test" },
				}),
			);

			const results = await searchWithDb(db, "FTS Locale", {
				collections: ["post"],
				locale: "ja",
				status: "published",
			});

			expect(results.items).toHaveLength(1);
			expect(results.items[0]!.locale).toBe("ja");
		});

		it("rebuilt index preserves locale-aware search", async () => {
			// Create content before rebuild
			await repo.create(
				createPostFixture({
					slug: "pre-rebuild-en",
					locale: "en",
					status: "published",
					data: { title: "Rebuild Test English" },
				}),
			);

			await repo.create(
				createPostFixture({
					slug: "pre-rebuild-fr",
					locale: "fr",
					status: "published",
					data: { title: "Rebuild Test French" },
				}),
			);

			// Rebuild the index
			await ftsManager.rebuildIndex("post", ["title"]);

			// Verify locale-aware search still works
			const enResults = await searchWithDb(db, "Rebuild", {
				collections: ["post"],
				locale: "en",
				status: "published",
			});

			expect(enResults.items).toHaveLength(1);
			expect(enResults.items[0]!.locale).toBe("en");
		});
	});

	// ─── 4. Seed — locale-aware content ─────────────────────────────

	describe("Seed — locale-aware content", () => {
		it("applySeed() creates content with locale and translationOf", async () => {
			const seed: SeedFile = {
				version: "1",
				content: {
					post: [
						{
							id: "welcome",
							slug: "welcome",
							locale: "en",
							status: "published",
							data: { title: "Welcome" },
						},
						{
							id: "welcome-fr",
							slug: "bienvenue",
							locale: "fr",
							translationOf: "welcome",
							status: "draft",
							data: { title: "Bienvenue" },
						},
						{
							id: "welcome-de",
							slug: "willkommen",
							locale: "de",
							translationOf: "welcome",
							status: "published",
							data: { title: "Willkommen" },
						},
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.content.created).toBe(3);
			expect(result.content.skipped).toBe(0);

			// Verify the entries exist with correct locales
			const seedRepo = new ContentRepository(db);
			const enPost = await seedRepo.findBySlug("post", "welcome", "en");
			const frPost = await seedRepo.findBySlug("post", "bienvenue", "fr");
			const dePost = await seedRepo.findBySlug("post", "willkommen", "de");

			expect(enPost).not.toBeNull();
			expect(frPost).not.toBeNull();
			expect(dePost).not.toBeNull();

			expect(enPost!.locale).toBe("en");
			expect(frPost!.locale).toBe("fr");
			expect(dePost!.locale).toBe("de");

			// All should share the same translation_group
			expect(frPost!.translationGroup).toBe(enPost!.translationGroup);
			expect(dePost!.translationGroup).toBe(enPost!.translationGroup);
		});

		it("applySeed() without locale falls back to default", async () => {
			const seed: SeedFile = {
				version: "1",
				content: {
					post: [
						{
							id: "plain",
							slug: "plain-post",
							data: { title: "No Locale" },
						},
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });
			expect(result.content.created).toBe(1);

			const plainRepo = new ContentRepository(db);
			const post = await plainRepo.findBySlug("post", "plain-post");
			expect(post).not.toBeNull();
			expect(post!.locale).toBe("en"); // default
			expect(post!.translationGroup).toBe(post!.id); // self-reference
		});

		it("applySeed() skips existing entries with locale-aware lookup", async () => {
			// Pre-create an entry
			const skipRepo = new ContentRepository(db);
			await skipRepo.create(createPostFixture({ slug: "existing", locale: "fr" }));

			const seed: SeedFile = {
				version: "1",
				content: {
					post: [
						{
							id: "existing",
							slug: "existing",
							locale: "fr",
							data: { title: "Should Skip" },
						},
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });
			expect(result.content.skipped).toBe(1);
			expect(result.content.created).toBe(0);
		});

		it("applySeed() rejects missing translationOf via validation", async () => {
			const seed: SeedFile = {
				version: "1",
				content: {
					post: [
						{
							id: "orphan-fr",
							slug: "orphelin",
							locale: "fr",
							translationOf: "nonexistent",
							data: { title: "Orphan" },
						},
					],
				},
			};

			// Validation catches the bad reference before applySeed runs
			await expect(applySeed(db, seed, { includeContent: true })).rejects.toThrow(
				'references "nonexistent" which is not in this collection',
			);
		});
	});

	// ─── 5. Seed validation — i18n fields ───────────────────────────

	describe("Seed validation — i18n fields", () => {
		it("validates translationOf requires locale", () => {
			const seed = {
				version: "1",
				content: {
					posts: [
						{ id: "en", slug: "hello", data: { title: "Hello" } },
						{
							id: "fr",
							slug: "bonjour",
							translationOf: "en",
							data: { title: "Bonjour" },
						},
					],
				},
			};

			const result = validateSeed(seed);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("locale is required when translationOf"))).toBe(
				true,
			);
		});

		it("validates translationOf references exist", () => {
			const seed = {
				version: "1",
				content: {
					posts: [
						{
							id: "fr",
							slug: "bonjour",
							locale: "fr",
							translationOf: "nonexistent",
							data: { title: "Bonjour" },
						},
					],
				},
			};

			const result = validateSeed(seed);
			expect(result.valid).toBe(false);
			expect(
				result.errors.some((e) => e.includes('references "nonexistent" which is not in')),
			).toBe(true);
		});

		it("valid seed with i18n fields passes validation", () => {
			const seed = {
				version: "1",
				content: {
					posts: [
						{ id: "en", slug: "hello", locale: "en", data: { title: "Hello" } },
						{
							id: "fr",
							slug: "bonjour",
							locale: "fr",
							translationOf: "en",
							data: { title: "Bonjour" },
						},
					],
				},
			};

			const result = validateSeed(seed);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	// ─── 6. Non-i18n regression ─────────────────────────────────────

	describe("Non-i18n regression", () => {
		it("content created without locale has locale 'en'", async () => {
			const post = await repo.create({
				type: "post",
				slug: "no-locale",
				data: { title: "No Locale Specified" },
			});

			expect(post.locale).toBe("en");
		});

		it("findMany without locale param returns all results", async () => {
			await repo.create(createPostFixture({ slug: "post-1" }));
			await repo.create(createPostFixture({ slug: "post-2" }));

			const result = await repo.findMany("post");
			expect(result.items).toHaveLength(2);
		});

		it("findBySlug works without locale param", async () => {
			const created = await repo.create(createPostFixture({ slug: "find-me" }));
			const found = await repo.findBySlug("post", "find-me");

			expect(found).not.toBeNull();
			expect(found!.id).toBe(created.id);
		});

		it("findByIdOrSlug works without locale param", async () => {
			const created = await repo.create(createPostFixture({ slug: "lookup-test" }));

			// By slug
			const bySlug = await repo.findByIdOrSlug("post", "lookup-test");
			expect(bySlug).not.toBeNull();
			expect(bySlug!.id).toBe(created.id);

			// By ID
			const byId = await repo.findByIdOrSlug("post", created.id);
			expect(byId).not.toBeNull();
			expect(byId!.id).toBe(created.id);
		});

		it("slug uniqueness is still enforced within the same locale", async () => {
			await repo.create(createPostFixture({ slug: "dupe-test" }));

			// Same slug, same default locale — should fail
			await expect(repo.create(createPostFixture({ slug: "dupe-test" }))).rejects.toThrow();
		});

		it("count works without locale param", async () => {
			await repo.create(createPostFixture({ slug: "count-1" }));
			await repo.create(createPostFixture({ slug: "count-2" }));

			const count = await repo.count("post");
			expect(count).toBe(2);
		});

		it("translation_group is auto-set to item id when no translationOf", async () => {
			const post = await repo.create(createPostFixture({ slug: "standalone" }));

			expect(post.translationGroup).toBe(post.id);
		});

		it("existing CRUD operations are unaffected by i18n columns", async () => {
			// Create
			const post = await repo.create(createPostFixture({ slug: "crud-test", status: "draft" }));
			expect(post.status).toBe("draft");

			// Update
			const updated = await repo.update("post", post.id, {
				data: { title: "Updated Title" },
			});
			expect(updated.data.title).toBe("Updated Title");
			expect(updated.locale).toBe("en"); // locale unchanged

			// Delete (soft)
			const deleted = await repo.delete("post", post.id);
			expect(deleted).toBe(true);

			// Should not be found
			const notFound = await repo.findById("post", post.id);
			expect(notFound).toBeNull();

			// Restore
			const restored = await repo.restore("post", post.id);
			expect(restored).toEqual(expect.objectContaining({ id: post.id, locale: "en" }));

			const found = await repo.findById("post", post.id);
			expect(found).not.toBeNull();
			expect(found!.locale).toBe("en");
		});
	});
});
