import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	handleContentCreate,
	handleContentDuplicate,
	handleContentGet,
	handleContentList,
	handleContentUpdate,
} from "../../../src/api/index.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	setupTestDatabase,
	setupTestDatabaseWithCollections,
	teardownTestDatabase,
} from "../../utils/test-db.js";

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

		// When the caller omits `locale`, the handler must defer to the
		// configured site defaultLocale rather than falling back to the
		// repo's hard-coded "en". Otherwise non-English default-locale
		// sites silently create entries in a locale the editor never chose.
		it("defaults to configured i18n defaultLocale when body.locale is omitted", async () => {
			setI18nConfig({ defaultLocale: "es", locales: ["es", "en"] });
			try {
				const result = await handleContentCreate(db, "post", {
					data: { title: "Hola" },
				});

				expect(result.success).toBe(true);
				expect(result.data?.item.locale).toBe("es");
			} finally {
				setI18nConfig(null);
			}
		});

		it("falls back to 'en' when no i18n config is set", async () => {
			setI18nConfig(null);
			const result = await handleContentCreate(db, "post", {
				data: { title: "No i18n" },
			});

			expect(result.success).toBe(true);
			expect(result.data?.item.locale).toBe("en");
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

	describe("handleContentUpdate — locale-aware slug resolution", () => {
		it("updates the row matching body.locale when the identifier is a shared slug", async () => {
			const slug = "shared-locale-update";
			const en = await handleContentCreate(db, "post", {
				data: { title: "English" },
				slug,
				locale: "en",
			});
			const fr = await handleContentCreate(db, "post", {
				data: { title: "French" },
				slug,
				locale: "fr",
			});
			expect(en.success).toBe(true);
			expect(fr.success).toBe(true);

			const currentFr = await handleContentGet(db, "post", slug, "fr");
			expect(currentFr.success).toBe(true);

			const updated = await handleContentUpdate(db, "post", slug, {
				data: { title: "French Updated" },
				locale: "fr",
				_rev: currentFr.data!._rev,
			});

			expect(updated.success).toBe(true);
			expect(updated.data?.item.id).toBe(fr.data?.item.id);
			expect(updated.data?.item.locale).toBe("fr");
			expect(updated.data?.item.data.title).toBe("French Updated");

			const fetchedEn = await handleContentGet(db, "post", slug, "en");
			const fetchedFr = await handleContentGet(db, "post", slug, "fr");
			expect(fetchedEn.data?.item.data.title).toBe("English");
			expect(fetchedFr.data?.item.data.title).toBe("French Updated");
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

	describe("byline i18n (migration 040)", () => {
		it("sets primaryBylineId to the credited byline's translation_group, not the wire row id", async () => {
			const bylineRepo = new BylineRepository(db);
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			// Editor credits the fr row on a fr entry. The wire bylineId is
			// fr.id but the server should store the translation_group (which
			// equals anchor.id for the anchor sibling). The in-memory
			// `primaryBylineId` on the response must match what's now in the
			// DB column.
			const created = await handleContentCreate(db, "post", {
				data: { title: "Bonjour" },
				locale: "fr",
				bylines: [{ bylineId: fr.id }],
			});

			expect(created.success).toBe(true);
			expect(created.data?.item.primaryBylineId).toBe(anchor.id);
			expect(created.data?.item.primaryBylineId).toBe(anchor.translationGroup);
			// fr post hydrates with the fr sibling.
			expect(created.data?.item.byline?.id).toBe(fr.id);
			expect(created.data?.item.byline?.locale).toBe("fr");
		});

		it("hydrates the locale-matching sibling on a translated entry", async () => {
			const bylineRepo = new BylineRepository(db);
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			// Credit using the anchor (en) wire id on an EN entry, then
			// translate the entry. The fr-locale entry should hydrate the fr
			// byline sibling, not the en one.
			const enEntry = await handleContentCreate(db, "post", {
				data: { title: "Hello" },
				locale: "en",
				bylines: [{ bylineId: anchor.id }],
			});
			expect(enEntry.success).toBe(true);
			expect(enEntry.data?.item.byline?.locale).toBe("en");

			const frEntry = await handleContentCreate(db, "post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: enEntry.data!.item.id,
			});
			expect(frEntry.success).toBe(true);
			expect(frEntry.data?.item.byline?.displayName).toBe("Jeanne");
			expect(frEntry.data?.item.byline?.locale).toBe("fr");
		});

		it("hydrates strict per locale — credit absent when no sibling exists at the entry's locale", async () => {
			const bylineRepo = new BylineRepository(db);
			const anchor = await bylineRepo.create({
				slug: "marco",
				displayName: "Marco",
				locale: "en",
			});

			const enEntry = await handleContentCreate(db, "post", {
				data: { title: "Hello" },
				locale: "en",
				bylines: [{ bylineId: anchor.id }],
			});
			expect(enEntry.success).toBe(true);

			// Translate to fr — no fr sibling exists for marco. The credit is
			// preserved at the DB level (`copyContentBylines` clones the
			// junction row pointing at marco's translation_group), but
			// rendering on the fr entry returns nothing because the byline
			// has no fr sibling.
			const frEntry = await handleContentCreate(db, "post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: enEntry.data!.item.id,
			});
			expect(frEntry.success).toBe(true);
			expect(frEntry.data?.item.bylines).toEqual([]);
			expect(frEntry.data?.item.byline).toBeNull();
			// But the DB-level pointer is preserved — the credit will surface
			// the moment an fr sibling of marco is created.
			expect(frEntry.data?.item.primaryBylineId).toBe(anchor.id);
		});

		it("copyContentBylines runs on translationOf when body.bylines is omitted", async () => {
			const bylineRepo = new BylineRepository(db);
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const enEntry = await handleContentCreate(db, "post", {
				data: { title: "Hello" },
				locale: "en",
				bylines: [{ bylineId: anchor.id }],
			});
			expect(enEntry.success).toBe(true);

			const frEntry = await handleContentCreate(db, "post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: enEntry.data!.item.id,
				// No `bylines` field — copy should run.
			});
			expect(frEntry.success).toBe(true);
			expect(frEntry.data?.item.bylines).toHaveLength(1);
			expect(frEntry.data?.item.byline?.locale).toBe("fr");
		});

		it("respects explicit body.bylines on translationOf and skips copying", async () => {
			const bylineRepo = new BylineRepository(db);
			const a = await bylineRepo.create({ slug: "a", displayName: "A", locale: "en" });
			const b = await bylineRepo.create({ slug: "b", displayName: "B", locale: "en" });
			// fr sibling of `b`. The fr entry will be credited with this row.
			const bFr = await bylineRepo.create({
				slug: "b",
				displayName: "B-fr",
				locale: "fr",
				translationOf: b.id,
			});

			const enEntry = await handleContentCreate(db, "post", {
				data: { title: "Hello" },
				locale: "en",
				bylines: [{ bylineId: a.id }],
			});
			expect(enEntry.success).toBe(true);

			// Explicit different byline on the translation — should NOT
			// inherit from source. The fr entry should credit `b`'s fr
			// sibling, not `a`.
			const frEntry = await handleContentCreate(db, "post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: enEntry.data!.item.id,
				bylines: [{ bylineId: bFr.id }],
			});
			expect(frEntry.success).toBe(true);
			expect(frEntry.data?.item.bylines).toHaveLength(1);
			expect(frEntry.data?.item.byline?.id).toBe(bFr.id);
		});

		it("does not fall back to author-linked byline when explicit credits exist at another locale", async () => {
			// Bug 1 regression: strict per-locale hydration returns [] when a
			// credit's translation_group has no sibling at the entry's
			// locale, but the old code treated that as "no explicit
			// credits" and inferred the author byline. The editor's intent
			// was explicit ("credit Marco, not the article's author") —
			// silently overriding with an inferred byline is wrong.
			const userRepo = new UserRepository(db);
			const author = await userRepo.create({
				email: "fallback-test@example.com",
				displayName: "Author Account",
				role: "editor",
			});
			const bylineRepo = new BylineRepository(db);
			// Author has a fr byline. If we incorrectly fell back, this
			// would surface on a fr entry that has an unresolved en-only
			// credit.
			await bylineRepo.create({
				slug: "author-fr",
				displayName: "Auteur",
				locale: "fr",
				userId: author.id,
			});

			const marco = await bylineRepo.create({
				slug: "marco",
				displayName: "Marco",
				locale: "en",
			});

			const enEntry = await handleContentCreate(db, "post", {
				data: { title: "Hello" },
				locale: "en",
				authorId: author.id,
				bylines: [{ bylineId: marco.id }],
			});
			expect(enEntry.success).toBe(true);

			const frEntry = await handleContentCreate(db, "post", {
				data: { title: "Bonjour" },
				locale: "fr",
				authorId: author.id,
				translationOf: enEntry.data!.item.id,
			});
			expect(frEntry.success).toBe(true);
			// The explicit credit was copied to the fr entry (via
			// `copyContentBylines`). It doesn't render at fr because marco
			// has no fr sibling. Author inference must NOT step in — the
			// editor explicitly named marco, not the author.
			expect(frEntry.data?.item.bylines).toEqual([]);
			expect(frEntry.data?.item.byline).toBeNull();
		});

		it("inferred (author-linked) byline still works when the entry has no explicit credits at all", async () => {
			// Counterpoint to the previous test: when no junction rows
			// exist, author inference is the right thing to do — Phase 4
			// hydration must preserve this fallback for entries that were
			// never explicitly credited.
			const userRepo = new UserRepository(db);
			const author = await userRepo.create({
				email: "implicit-author@example.com",
				displayName: "Implicit",
				role: "editor",
			});
			const bylineRepo = new BylineRepository(db);
			await bylineRepo.create({
				slug: "implicit",
				displayName: "Implicit EN",
				locale: "en",
				userId: author.id,
			});

			const created = await handleContentCreate(db, "post", {
				data: { title: "Hello" },
				locale: "en",
				authorId: author.id,
				// No bylines field — author inference path.
			});
			expect(created.success).toBe(true);
			expect(created.data?.item.bylines).toHaveLength(1);
			expect(created.data?.item.bylines?.[0]?.source).toBe("inferred");
			expect(created.data?.item.byline?.displayName).toBe("Implicit EN");
		});

		it("hydrateBylinesMany resolves each entry against its own locale", async () => {
			const bylineRepo = new BylineRepository(db);
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			// Two entries at different locales, both credited with the same
			// translation_group (via the anchor wire id). A list endpoint
			// returning both at once should hydrate each one against its own
			// locale.
			const enEntry = await handleContentCreate(db, "post", {
				data: { title: "Hello" },
				locale: "en",
				bylines: [{ bylineId: anchor.id }],
			});
			const frEntry = await handleContentCreate(db, "post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: enEntry.data!.item.id,
			});
			expect(enEntry.success && frEntry.success).toBe(true);

			const listed = await handleContentList(db, "post", {});
			expect(listed.success).toBe(true);
			const enItem = listed.data?.items.find((i) => i.id === enEntry.data!.item.id);
			const frItem = listed.data?.items.find((i) => i.id === frEntry.data!.item.id);
			expect(enItem?.byline?.locale).toBe("en");
			expect(frItem?.byline?.locale).toBe("fr");
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

describe("Content Handlers — list total", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		// Seed enough items that limit-based pagination kicks in and we can
		// assert total > items.length.
		for (let i = 0; i < 8; i++) {
			const result = await handleContentCreate(db, "post", {
				data: { title: `Post ${i}` },
			});
			if (!result.success) throw new Error("seed failed");
		}
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns total independent of limit", async () => {
		const result = await handleContentList(db, "post", { limit: 2 });

		expect(result.success).toBe(true);
		expect(result.data?.items).toHaveLength(2);
		expect(result.data?.total).toBe(8);
	});
});

describe("handleContentList — backing table missing deleted_at column", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await sql`
			CREATE TABLE ec_repro_test (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				title TEXT NOT NULL,
				content JSON,
				excerpt TEXT,
				status TEXT NOT NULL,
				locale TEXT NOT NULL DEFAULT 'en',
				published_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`.execute(db);
		await sql`
			INSERT INTO ec_repro_test (id, slug, title, content, excerpt, status, locale, published_at, created_at, updated_at)
			VALUES ('01KPQZA8J1E206F60QSNFRX3Y2', 'repro', 'Repro entry', '[]', 'x', 'published', 'en',
				'2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
		`.execute(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("reports a schema mismatch instead of a generic list error", async () => {
		const res = await handleContentList(db, "repro_test", {});
		expect(res.success).toBe(false);
		if (res.success) return;
		expect(res.error.code).toBe("COLLECTION_SCHEMA_MISMATCH");
		expect(res.error.message).toContain("repro_test");
	});
});

describe("handleContentList — unknown orderBy column on a healthy collection", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("does not report a schema mismatch when ordering by a field the collection lacks", async () => {
		const res = await handleContentList(db, "post", { orderBy: "name" });
		expect(res.success).toBe(false);
		if (res.success) return;
		expect(res.error.code).not.toBe("COLLECTION_SCHEMA_MISMATCH");
	});
});
