import { LiveEntryNotFoundError } from "astro/content/runtime";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getBylineBySlug } from "../../../src/bylines/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { normalizeAstroI18n } from "../../../src/i18n/normalize.js";
import { localeMatches } from "../../../src/i18n/query.js";
import { emdashLoader } from "../../../src/loader.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { getEmDashCollection, getEmDashEntry } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { getTaxonomyDef, getTaxonomyTerms, getTerm } from "../../../src/taxonomies/index.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveEntry: async (
		_collection: string,
		options: { type: string; id: string; locale?: string },
	) => {
		const loaded = await emdashLoader().loadEntry!({ filter: options });
		if (loaded && !("error" in loaded)) return { entry: loaded, error: undefined };
		return {
			entry: undefined,
			error:
				loaded && "error" in loaded
					? loaded.error
					: new LiveEntryNotFoundError(options.type, options.id),
		};
	},
	getLiveCollection: async (_collection: string, options: { type: string; locale?: string }) =>
		emdashLoader().loadCollection!({ filter: options }),
}));

const localeConfig = normalizeAstroI18n({
	defaultLocale: "es-MX",
	locales: ["es-MX", { path: "en", codes: ["en-US", "en-GB"] }],
	fallback: { en: "es-MX" },
});

const seed: SeedFile = {
	version: "1",
	collections: [
		{ slug: "pages", label: "Pages", fields: [{ slug: "title", label: "Title", type: "string" }] },
	],
	taxonomies: [
		{
			id: "category-es",
			name: "category",
			label: "Categoría",
			labelSingular: "Categoría",
			hierarchical: false,
			collections: ["pages"],
			locale: "es-MX",
			terms: [{ id: "news-es", slug: "news", label: "Noticias", locale: "es-MX" }],
		},
		{
			id: "category-en",
			name: "category",
			label: "Category",
			labelSingular: "Category",
			locale: "en",
			translationOf: "category-es",
			terms: [
				{
					id: "news-en",
					slug: "news",
					label: "News",
					locale: "en",
					translationOf: "news-es",
				},
			],
		},
	],
	menus: [
		{
			id: "primary-es",
			name: "primary",
			label: "Principal",
			locale: "es-MX",
			items: [{ id: "home-es", type: "custom", label: "Inicio", url: "/" }],
		},
		{
			id: "primary-en",
			name: "primary",
			label: "Primary",
			locale: "en",
			translationOf: "primary-es",
			items: [
				{
					id: "home-en",
					type: "custom",
					label: "Home",
					url: "/en/",
					translationOf: "home-es",
				},
			],
		},
	],
	bylines: [{ id: "author", slug: "author", displayName: "Author" }],
	content: {
		pages: [
			{
				id: "terms-es",
				slug: "terms",
				locale: "es-MX",
				status: "published",
				data: { title: "Términos" },
			},
			{
				id: "terms-en",
				slug: "terms",
				locale: "en",
				translationOf: "terms-es",
				status: "published",
				data: { title: "Terms" },
			},
		],
	},
};

describeEachDialect("legacy object-locale compatibility", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		setI18nConfig(localeConfig);
		await applySeed(db, structuredClone(seed), { includeContent: true });

		await sql`UPDATE ec_pages SET locale = 'en-US' WHERE slug = 'terms' AND locale = 'en'`.execute(
			db,
		);
		await sql`UPDATE _emdash_menus SET locale = 'en-US' WHERE id =
			(SELECT id FROM _emdash_menus WHERE name = 'primary' AND locale = 'en')`.execute(db);
		await sql`UPDATE _emdash_menu_items SET locale = 'en-US' WHERE menu_id IN
			(SELECT id FROM _emdash_menus WHERE name = 'primary' AND locale = 'en-US')`.execute(db);
		await sql`UPDATE _emdash_taxonomy_defs SET locale = 'en-US' WHERE name = 'category' AND locale = 'en'`.execute(
			db,
		);
		await sql`UPDATE taxonomies SET locale = 'en-US' WHERE name = 'category' AND locale = 'en'`.execute(
			db,
		);
		await sql`UPDATE _emdash_bylines SET locale = 'en-US' WHERE slug = 'author'`.execute(db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it.skipIf(dialect !== "sqlite")("keeps alias-filtered listings on the locale index", async () => {
		const plan = await sql<{ detail: string }>`EXPLAIN QUERY PLAN
			SELECT id FROM ec_pages WHERE ${localeMatches("locale", "en-US")}`.execute(db);
		expect(plan.rows.map((row) => row.detail).join(" ")).toMatch(
			/USING (?:COVERING )?INDEX idx_ec_pages_locale/,
		);
	});

	it("reads legacy content by Astro code and lists it without default-locale fallback", async () => {
		const entry = await runWithContext({ db, editMode: false }, () =>
			getEmDashEntry("pages", "terms", { locale: "en-US" }),
		);
		expect(entry.entry?.data.title).toBe("Terms");
		expect(entry.fallbackLocale).toBeUndefined();

		const collection = await runWithContext({ db, editMode: false }, () =>
			getEmDashCollection("pages", { locale: "en" }),
		);
		expect(collection.entries.map((item) => item.data.title)).toEqual(["Terms"]);

		const legacyId = await db
			.selectFrom("ec_pages")
			.select("id")
			.where("slug", "=", "terms")
			.where("locale", "=", "en-US")
			.executeTakeFirstOrThrow();
		const loaded = await runWithContext({ db, editMode: false }, () =>
			emdashLoader().loadEntry!({
				filter: { type: "pages", id: legacyId.id, locale: "en-US" },
			}),
		);
		expect(loaded && !("error" in loaded) ? loaded.data.title : undefined).toBe("Terms");
	});

	it("keeps path/code collisions addressable and prefers the configured path", async () => {
		const runtime = createTestRuntime(db);
		setI18nConfig(null);
		const created = await new ContentRepository(db).create({
			type: "pages",
			slug: "terms",
			locale: "en",
			data: { title: "Canonical path" },
		});
		setI18nConfig(localeConfig);
		const published = await runtime.handleContentPublish("pages", created.id);
		expect(published.success).toBe(true);

		const pathResult = await runWithContext({ db, editMode: false }, () =>
			getEmDashEntry("pages", "terms", { locale: "en" }),
		);
		expect(pathResult.entry?.data.title).toBe("Canonical path");
		const legacyId = await db
			.selectFrom("ec_pages")
			.select("id")
			.where("slug", "=", "terms")
			.where("locale", "=", "en-US")
			.executeTakeFirstOrThrow();
		const byLegacyId = await runWithContext({ db, editMode: true }, () =>
			getEmDashEntry("pages", legacyId.id, { locale: "en-US" }),
		);
		expect(byLegacyId.entry?.data.title).toBe("Terms");
		const byCanonicalId = await runWithContext({ db, editMode: true }, () =>
			getEmDashEntry("pages", created.id, { locale: "en" }),
		);
		expect(byCanonicalId.entry?.data.title).toBe("Canonical path");
		const all = await runWithContext({ db, editMode: true }, () =>
			getEmDashCollection("pages", { locale: "en-US" }),
		);
		expect(
			all.entries
				.map((item) => item.data.title)
				.toSorted((a, b) => String(a).localeCompare(String(b))),
		).toEqual(["Canonical path", "Terms"]);
	});

	it("rejects explicit alias-aware slug collisions on create and update", async () => {
		const runtime = createTestRuntime(db);
		const created = await runtime.handleContentCreate("pages", {
			slug: "terms",
			locale: "en",
			data: { title: "Duplicate canonical" },
		});
		expect(created).toMatchObject({ success: false, error: { code: "SLUG_CONFLICT" } });

		const other = await runtime.handleContentCreate("pages", {
			slug: "other",
			locale: "en",
			data: { title: "Other canonical" },
		});
		expect(other.success).toBe(true);
		if (!other.success) return;
		const updated = await runtime.handleContentUpdate("pages", other.data.item.id, {
			slug: "terms",
			locale: "en",
		});
		expect(updated).toMatchObject({ success: false, error: { code: "SLUG_CONFLICT" } });
	});

	it("rejects a new translation when a legacy code sibling already exists", async () => {
		const spanish = await db
			.selectFrom("ec_pages")
			.select("id")
			.where("locale", "=", "es-MX")
			.executeTakeFirstOrThrow();
		const result = await createTestRuntime(db).handleContentCreate("pages", {
			slug: "another-slug",
			locale: "en",
			translationOf: spanish.id,
			data: { title: "Duplicate English" },
		});
		expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(await db.selectFrom("ec_pages").select("id").execute()).toHaveLength(2);
	});

	it("does not let a draft path row hide a published code row", async () => {
		setI18nConfig(null);
		await new ContentRepository(db).create({
			type: "pages",
			slug: "terms",
			locale: "en",
			data: { title: "Path draft" },
		});
		setI18nConfig(localeConfig);
		const published = await runWithContext({ db, editMode: false }, () =>
			getEmDashEntry("pages", "terms", { locale: "en-US" }),
		);
		expect(published.error).toBeUndefined();
		expect(published.entry?.data.title).toBe("Terms");
		expect(published.fallbackLocale).toBeUndefined();
		const draft = await runWithContext({ db, editMode: true }, () =>
			getEmDashEntry("pages", "terms", { locale: "en-US" }),
		);
		expect(draft.error).toBeUndefined();
		expect(draft.entry?.data.title).toBe("Path draft");
	});

	it("prefers the first configured code when only legacy code variants exist", async () => {
		setI18nConfig(null);
		const second = await new ContentRepository(db).create({
			type: "pages",
			slug: "terms",
			locale: "en-GB",
			data: { title: "Secondary code" },
		});
		const published = await createTestRuntime(db).handleContentPublish("pages", second.id);
		expect(published.success).toBe(true);
		setI18nConfig(localeConfig);
		const result = await runWithContext({ db, editMode: false }, () =>
			getEmDashEntry("pages", "terms", { locale: "en-GB" }),
		);
		expect(result.error).toBeUndefined();
		expect(result.entry?.data.title).toBe("Terms");
		expect(result.fallbackLocale).toBeUndefined();
	});

	it("resolves legacy menus, taxonomy, and bylines, and seed reruns preserve IDs", async () => {
		const menu = await getMenuWithDb("primary", db, { locale: "en-US" });
		expect(menu?.locale).toBe("en-US");
		expect(menu?.items[0]?.label).toBe("Home");
		const childLocale = await db
			.selectFrom("_emdash_menu_items")
			.select("locale")
			.where("menu_id", "=", menu!.id)
			.executeTakeFirstOrThrow();
		expect(childLocale.locale).toBe("en-US");

		const definition = await runWithContext({ db, editMode: false }, () =>
			getTaxonomyDef("category", { locale: "en-US" }),
		);
		expect(definition?.label).toBe("Category");
		const terms = await runWithContext({ db, editMode: false }, () =>
			getTaxonomyTerms("category", { locale: "en-US", includeCounts: false }),
		);
		expect(terms.map((term) => term.label)).toEqual(["News"]);
		const term = await runWithContext({ db, editMode: false }, () =>
			getTerm("category", "news", { locale: "en-US", includeCounts: false }),
		);
		expect(term?.label).toBe("News");
		const byline = await runWithContext({ db, editMode: false }, () =>
			getBylineBySlug("author", { locale: "en-US" }),
		);
		expect(byline?.displayName).toBe("Author");

		const snapshot = async () => ({
			pages: await db.selectFrom("ec_pages").select(["id", "locale"]).orderBy("id").execute(),
			menus: await db.selectFrom("_emdash_menus").select(["id", "locale"]).orderBy("id").execute(),
			menuItems: await db
				.selectFrom("_emdash_menu_items")
				.select(["menu_id", "locale"])
				.orderBy("menu_id")
				.orderBy("locale")
				.execute(),
			defs: await db
				.selectFrom("_emdash_taxonomy_defs")
				.select(["id", "locale"])
				.orderBy("id")
				.execute(),
			taxonomies: await db
				.selectFrom("taxonomies")
				.select(["id", "locale"])
				.orderBy("id")
				.execute(),
			bylines: await db
				.selectFrom("_emdash_bylines")
				.select(["id", "locale"])
				.orderBy("id")
				.execute(),
		});
		const before = await snapshot();
		await applySeed(db, structuredClone(seed), {
			includeContent: true,
			onConflict: "update",
		});
		const afterPath = await snapshot();
		const codeSeed = structuredClone(seed);
		codeSeed.content!.pages[1]!.locale = "en-US";
		codeSeed.taxonomies![1]!.locale = "en-US";
		codeSeed.taxonomies![1]!.terms[0]!.locale = "en-US";
		codeSeed.menus![1]!.locale = "en-US";
		codeSeed.menus![1]!.items[0]!.locale = "en-US";
		await applySeed(db, codeSeed, {
			includeContent: true,
			onConflict: "update",
		});
		const afterCode = await snapshot();
		for (const current of [afterPath, afterCode]) {
			expect(current.pages).toEqual(before.pages);
			expect(current.menus).toEqual(before.menus);
			expect(current.defs).toEqual(before.defs);
			expect(current.taxonomies).toEqual(before.taxonomies);
			expect(current.bylines).toEqual(before.bylines);
			expect(current.menuItems).toHaveLength(before.menuItems.length);
			expect(current.menuItems).toEqual(before.menuItems);
		}
	});
});
