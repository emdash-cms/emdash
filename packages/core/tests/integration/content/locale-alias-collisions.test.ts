import { LiveEntryNotFoundError } from "astro/content/runtime";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getBylineBySlug } from "../../../src/bylines/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { normalizeAstroI18n } from "../../../src/i18n/normalize.js";
import { emdashLoader } from "../../../src/loader.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { getEmDashEntry } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { getTaxonomyDef, getTaxonomyTerms, getTerm } from "../../../src/taxonomies/index.js";
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
}));

const config = normalizeAstroI18n({
	defaultLocale: "es-MX",
	locales: ["es-MX", { path: "en", codes: ["en-US", "en-GB"] }],
	fallback: { en: "es-MX" },
});

const legacySeed: SeedFile = {
	version: "1",
	collections: [
		{ slug: "pages", label: "Pages", fields: [{ slug: "title", label: "Title", type: "string" }] },
	],
	taxonomies: [
		{
			id: "category-code",
			name: "category",
			label: "Code category",
			labelSingular: "Category",
			locale: "en-US",
			collections: ["pages"],
			hierarchical: false,
			terms: [{ id: "news-code", slug: "news", label: "Code news", locale: "en-US" }],
		},
	],
	menus: [
		{
			id: "primary-code",
			name: "primary",
			label: "Code menu",
			locale: "en-US",
			items: [{ id: "home-code", type: "custom", label: "Code home", url: "/code" }],
		},
	],
	bylines: [{ id: "author", slug: "author", displayName: "Code author" }],
	content: {
		pages: [
			{
				id: "page-code",
				slug: "collision",
				locale: "en-US",
				status: "published",
				data: { title: "Code page" },
				bylines: [{ byline: "author" }],
				taxonomies: { category: ["news"] },
			},
		],
	},
};

const pathSeed: SeedFile = {
	...legacySeed,
	bylines: [{ id: "author", slug: "author", displayName: "Path author" }],
	taxonomies: [
		{
			...legacySeed.taxonomies![0]!,
			id: "category-path",
			locale: "en",
			label: "Path category",

			terms: [
				{
					id: "news-path",
					slug: "news",
					label: "Path news",
					locale: "en",
				},
			],
		},
	],
	menus: [
		{
			...legacySeed.menus![0]!,
			id: "primary-path",
			locale: "en",
			label: "Path menu",

			items: [
				{
					id: "home-path",
					type: "custom",
					label: "Path home",
					url: "/en",
				},
			],
		},
	],
	content: {
		pages: [
			{
				...legacySeed.content!.pages[0]!,
				id: "page-path",
				locale: "en",
				data: { title: "Path page" },
			},
		],
	},
};

describeEachDialect("locale alias collisions preserve canonical rows", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let pathMenuId: string;
	let pathTermId: string;
	let codeTermId: string;
	let pathDefId: string;
	let codePageId: string;
	let pathPageId: string;
	let codeMenuId: string;
	let pathBylineId: string;
	let codeBylineId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		setI18nConfig(null);
		await applySeed(db, structuredClone(legacySeed), { includeContent: true });
		const legacyByline = await db
			.selectFrom("_emdash_bylines")
			.select("id")
			.where("slug", "=", "author")
			.executeTakeFirstOrThrow();
		codeBylineId = legacyByline.id;
		await db
			.updateTable("_emdash_bylines")
			.set("locale", "en-US")
			.where("id", "=", legacyByline.id)
			.execute();
		codePageId = (
			await db
				.selectFrom("ec_pages")
				.select("id")
				.where("slug", "=", "collision")
				.where("locale", "=", "en-US")
				.executeTakeFirstOrThrow()
		).id;
		codeMenuId = (
			await db
				.selectFrom("_emdash_menus")
				.select("id")
				.where("name", "=", "primary")
				.where("locale", "=", "en-US")
				.executeTakeFirstOrThrow()
		).id;
		codeTermId = (
			await db
				.selectFrom("taxonomies")
				.select("id")
				.where("name", "=", "category")
				.where("slug", "=", "news")
				.where("locale", "=", "en-US")
				.executeTakeFirstOrThrow()
		).id;
		await applySeed(db, structuredClone(pathSeed), { includeContent: true, onConflict: "update" });
		pathPageId = (
			await db
				.selectFrom("ec_pages")
				.select("id")
				.where("slug", "=", "collision")
				.where("locale", "=", "en")
				.executeTakeFirstOrThrow()
		).id;
		await sql`DELETE FROM content_taxonomies WHERE entry_id = (SELECT translation_group FROM ec_pages WHERE id = ${pathPageId}) AND taxonomy_id = (SELECT translation_group FROM taxonomies WHERE name = 'category' AND slug = 'news' AND locale = 'en')`.execute(
			db,
		);
		pathMenuId = (
			await db
				.selectFrom("_emdash_menus")
				.select("id")
				.where("name", "=", "primary")
				.where("locale", "=", "en")
				.executeTakeFirstOrThrow()
		).id;
		pathDefId = (
			await db
				.selectFrom("_emdash_taxonomy_defs")
				.select("id")
				.where("name", "=", "category")
				.where("locale", "=", "en")
				.executeTakeFirstOrThrow()
		).id;
		pathTermId = (
			await db
				.selectFrom("taxonomies")
				.select("id")
				.where("name", "=", "category")
				.where("slug", "=", "news")
				.where("locale", "=", "en")
				.executeTakeFirstOrThrow()
		).id;
		await sql`UPDATE _emdash_taxonomy_defs SET translation_group = (SELECT translation_group FROM _emdash_taxonomy_defs WHERE name = 'category' AND locale = 'en-US') WHERE name = 'category' AND locale = 'en'`.execute(
			db,
		);
		await sql`UPDATE taxonomies SET translation_group = (SELECT translation_group FROM taxonomies WHERE name = 'category' AND slug = 'news' AND locale = 'en-US') WHERE name = 'category' AND slug = 'news' AND locale = 'en'`.execute(
			db,
		);
		await sql`UPDATE _emdash_menus SET translation_group = (SELECT translation_group FROM _emdash_menus WHERE name = 'primary' AND locale = 'en-US') WHERE name = 'primary' AND locale = 'en'`.execute(
			db,
		);
		await sql`UPDATE _emdash_menu_items SET translation_group = (SELECT translation_group FROM _emdash_menu_items WHERE menu_id = ${codeMenuId}) WHERE menu_id = ${pathMenuId}`.execute(
			db,
		);
		await sql`UPDATE ec_pages SET translation_group = (SELECT translation_group FROM ec_pages WHERE id = ${codePageId}) WHERE id = ${pathPageId}`.execute(
			db,
		);
		setI18nConfig(config);

		const code = await db
			.selectFrom("_emdash_bylines")
			.selectAll()
			.where("slug", "=", "author")
			.where("locale", "=", "en-US")
			.executeTakeFirstOrThrow();
		await sql`DELETE FROM _emdash_content_bylines WHERE byline_id IN (SELECT id FROM _emdash_bylines WHERE slug = 'author' AND id != ${codeBylineId})`.execute(
			db,
		);
		await sql`DELETE FROM _emdash_bylines WHERE slug = 'author' AND id != ${codeBylineId}`.execute(
			db,
		);
		pathBylineId = "author-path";
		await db
			.insertInto("_emdash_bylines")
			.values({
				id: pathBylineId,
				slug: "author",
				display_name: "Path author",
				bio: null,
				avatar_media_id: null,
				website_url: null,
				user_id: null,
				is_guest: 1,
				locale: "en",
				translation_group: code.translation_group,
			})
			.execute();
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("chooses the path row for all aliases without deleting code rows", async () => {
		await runWithContext({ db, editMode: false }, async () => {
			const menu = await getMenuWithDb("primary", db, { locale: "en-US" });
			expect(menu?.id).toBe(pathMenuId);
			expect(menu?.items).toHaveLength(1);
			expect(menu?.items[0]?.label).toBe("Path home");

			const definition = await getTaxonomyDef("category", { locale: "en-US" });
			expect(definition?.id).toBe(pathDefId);
			const terms = await getTaxonomyTerms("category", { locale: "en-US", includeCounts: false });
			expect(terms).toHaveLength(2);
			expect(terms.map((term) => term.id)).toEqual(
				expect.arrayContaining([codeTermId, pathTermId]),
			);
			expect(
				(await getTerm("category", "news", { locale: "en-US", includeCounts: false }))?.id,
			).toBe(pathTermId);
			expect((await getBylineBySlug("author", { locale: "en-US" }))?.id).toBe(pathBylineId);

			const result = await runWithContext({ db, editMode: false }, () =>
				getEmDashEntry("pages", "collision", { locale: "en-US" }),
			);
			expect(result.entry?.data.title).toBe("Path page");
			expect(result.entry?.data.terms.category).toHaveLength(1);
			expect(result.entry?.data.terms.category[0]?.id).toBe(pathTermId);
			expect(result.entry?.data.bylines).toHaveLength(1);
			expect(result.entry?.data.bylines[0]?.byline.id).toBe(pathBylineId);
			const loaded = await runWithContext({ db, editMode: false }, () =>
				emdashLoader().loadEntry!({ filter: { type: "pages", id: codePageId, locale: "en-US" } }),
			);
			expect(loaded && !("error" in loaded) ? loaded.data.title : undefined).toBe("Code page");

			for (const table of [
				"_emdash_menus",
				"_emdash_taxonomy_defs",
				"taxonomies",
				"_emdash_bylines",
			] as const) {
				const rows = await db.selectFrom(table).select("id").execute();
				expect(rows).toHaveLength(table === "_emdash_taxonomy_defs" ? 3 : 2);
			}
		});
	});

	it("updates the canonical seed row without overwriting legacy code data", async () => {
		await runWithContext({ db, editMode: false }, async () => {
			const update = structuredClone(pathSeed);
			update.taxonomies![0]!.locale = "en-US";
			update.taxonomies![0]!.label = "Updated path category";
			update.taxonomies![0]!.terms[0]!.locale = "en-US";
			update.taxonomies![0]!.terms[0]!.label = "Updated path news";
			update.content!.pages[0]!.locale = "en-US";
			update.content!.pages[0]!.data = { title: "Updated path page" };
			update.menus![0]!.locale = "en-US";
			update.menus![0]!.items[0]!.label = "Updated path home";
			await applySeed(db, update, { includeContent: true, onConflict: "update" });
			const pathMenu = await getMenuWithDb("primary", db, { locale: "en-US" });
			expect(pathMenu?.id).toBe(pathMenuId);
			expect(pathMenu?.items[0]?.label).toBe("Updated path home");
			const codeMenuItem = await db
				.selectFrom("_emdash_menu_items")
				.select("label")
				.where("menu_id", "=", codeMenuId)
				.executeTakeFirstOrThrow();
			expect(codeMenuItem.label).toBe("Code home");
			await runWithContext({ db, editMode: false }, async () => {
				expect((await getTaxonomyDef("category", { locale: "en" }))?.label).toBe(
					"Updated path category",
				);
				expect(
					(await getTerm("category", "news", { locale: "en", includeCounts: false }))?.label,
				).toBe("Updated path news");
				expect(
					(await getEmDashEntry("pages", "collision", { locale: "en" })).entry?.data.title,
				).toBe("Updated path page");
			});
			const codePage = await new ContentRepository(db).findById("pages", codePageId);
			expect(codePage?.data.title).toBe("Code page");
		});
	});
});
