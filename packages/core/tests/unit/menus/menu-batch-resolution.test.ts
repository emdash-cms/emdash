import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

class QueryCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count += 1;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

describeEachDialect("batched menu reference resolution", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();

		await ctx.db
			.updateTable("_emdash_collections")
			.set({ url_pattern: "/pages/{slug}" })
			.where("slug", "=", "page")
			.execute();
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ url_pattern: "/articles/{slug}-{id}" })
			.where("slug", "=", "post")
			.execute();

		await ctx.db
			.insertInto("ec_page" as never)
			.values([
				{
					id: "page-local-en",
					slug: "contact",
					locale: "en",
					translation_group: "page-local",
				},
				{
					id: "page-local-fr",
					slug: "contact-fr",
					locale: "fr",
					translation_group: "page-local",
				},
				{
					id: "page-fallback-en",
					slug: "about",
					locale: "en",
					translation_group: "page-fallback",
				},
				{
					id: "page-fallback-es",
					slug: "acerca-de",
					locale: "es",
					translation_group: "page-fallback",
				},
				{
					id: "legacy-page-id",
					slug: "legacy",
					locale: "en",
					translation_group: "legacy-page-group",
				},
			] as never)
			.execute();

		await ctx.db
			.insertInto("ec_post" as never)
			.values([
				{
					id: "post-local-en",
					slug: "hello",
					locale: "en",
					translation_group: "post-local",
				},
				{
					id: "post-local-fr",
					slug: "bonjour",
					locale: "fr",
					translation_group: "post-local",
				},
				{
					id: "post-fallback-en",
					slug: "static",
					locale: "en",
					translation_group: "post-fallback",
				},
				{
					id: "post-fallback-es",
					slug: "estatico",
					locale: "es",
					translation_group: "post-fallback",
				},
			] as never)
			.execute();

		await ctx.db
			.insertInto("taxonomies")
			.values([
				{
					id: "taxonomy-local-en",
					name: "category",
					slug: "news",
					label: "News",
					parent_id: null,
					data: null,
					locale: "en",
					translation_group: "taxonomy-local",
				},
				{
					id: "taxonomy-local-fr",
					name: "category",
					slug: "nouvelles",
					label: "Nouvelles",
					parent_id: null,
					data: null,
					locale: "fr",
					translation_group: "taxonomy-local",
				},
				{
					id: "taxonomy-fallback-en",
					name: "tag",
					slug: "releases",
					label: "Releases",
					parent_id: null,
					data: null,
					locale: "en",
					translation_group: "taxonomy-fallback",
				},
				{
					id: "taxonomy-fallback-es",
					name: "tag",
					slug: "lanzamientos",
					label: "Lanzamientos",
					parent_id: null,
					data: null,
					locale: "es",
					translation_group: "taxonomy-fallback",
				},
				{
					id: "legacy-taxonomy-id",
					name: "category",
					slug: "legacy-topic",
					label: "Legacy topic",
					parent_id: null,
					data: null,
					locale: "en",
					translation_group: "legacy-taxonomy-group",
				},
			])
			.execute();

		await ctx.db
			.insertInto("_emdash_menus")
			.values({ id: "menu-primary-fr", name: "primary", label: "Primary", locale: "fr" })
			.execute();
		const contentItems: Array<[string, number, string, string, string, string]> = [
			["item-page-local", 1, "page", "page", "page-local", "Contact"],
			["item-page-fallback", 2, "page", "page", "page-fallback", "About"],
			["item-page-legacy", 3, "page", "page", "legacy-page-id", "Legacy page"],
			["item-post-local", 4, "post", "post", "post-local", "Bonjour"],
			["item-post-fallback", 5, "post", "post", "post-fallback", "Static"],
			["item-collection-entry", 6, "collection", "page", "page-fallback", "Featured page"],
		];
		const taxonomyItems: Array<[string, number, string, string]> = [
			["item-taxonomy-local", 8, "taxonomy-local", "Nouvelles"],
			["item-taxonomy-fallback", 9, "taxonomy-fallback", "Releases"],
			["item-taxonomy-legacy", 10, "legacy-taxonomy-id", "Legacy topic"],
		];
		await ctx.db
			.insertInto("_emdash_menu_items")
			.values([
				{
					id: "item-custom",
					menu_id: "menu-primary-fr",
					sort_order: 0,
					type: "custom",
					custom_url: "https://example.com/docs",
					label: "Docs",
					locale: "fr",
				},
				...contentItems.map(([id, sortOrder, type, collection, referenceId, label]) => ({
					id,
					menu_id: "menu-primary-fr",
					sort_order: sortOrder,
					type,
					reference_collection: collection,
					reference_id: referenceId,
					label,
					locale: "fr",
				})),
				{
					id: "item-collection-archive",
					menu_id: "menu-primary-fr",
					sort_order: 7,
					type: "collection",
					reference_collection: "page",
					label: "All pages",
					locale: "fr",
				},
				...taxonomyItems.map(([id, sortOrder, referenceId, label]) => ({
					id,
					menu_id: "menu-primary-fr",
					sort_order: sortOrder,
					type: "taxonomy",
					reference_id: referenceId,
					label,
					locale: "fr",
				})),
			])
			.execute();
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownForDialect(ctx);
	});

	it("resolves mixed locale references with a fixed query budget", async () => {
		const counter = new QueryCountingPlugin();
		const menu = await getMenuWithDb("primary", ctx.db.withPlugin(counter), {
			locale: "fr",
			trailingSlash: "always",
		});

		expect(menu?.items.map(({ label, url }) => ({ label, url }))).toEqual([
			{ label: "Docs", url: "https://example.com/docs" },
			{ label: "Contact", url: "/fr/pages/contact-fr/" },
			{ label: "About", url: "/fr/pages/about/" },
			{ label: "Legacy page", url: "/fr/pages/legacy/" },
			{ label: "Bonjour", url: "/fr/articles/bonjour-post-local-fr/" },
			{ label: "Static", url: "/fr/articles/static-post-fallback-en/" },
			{ label: "Featured page", url: "/fr/pages/about/" },
			{ label: "All pages", url: "/page/" },
			{ label: "Nouvelles", url: "/category/nouvelles" },
			{ label: "Releases", url: "/tag/releases" },
			{ label: "Legacy topic", url: "/category/legacy-topic" },
		]);
		expect(counter.count).toBe(7);
	});

	it("loads the requested locale's menu, or its fallback, with its items in one query", async () => {
		await ctx.db
			.insertInto("_emdash_menus")
			.values([
				{ id: "menu-footer-en", name: "footer", label: "Footer", locale: "en" },
				{ id: "menu-footer-fr", name: "footer", label: "Pied de page", locale: "fr" },
				{ id: "menu-social-en", name: "social", label: "Social", locale: "en" },
				{ id: "menu-empty-fr", name: "empty", label: "Empty", locale: "fr" },
			])
			.execute();
		await ctx.db
			.insertInto("_emdash_menu_items")
			.values(
				[
					["footer-en-1", "menu-footer-en", 0, "Imprint", "en"],
					["footer-fr-2", "menu-footer-fr", 1, "Contact", "fr"],
					["footer-fr-1", "menu-footer-fr", 0, "Mentions", "fr"],
					["social-en-1", "menu-social-en", 0, "Mastodon", "en"],
				].map(([id, menuId, sortOrder, label, locale]) => ({
					id: id as string,
					menu_id: menuId as string,
					sort_order: sortOrder as number,
					type: "custom",
					custom_url: "https://example.com",
					label: label as string,
					locale: locale as string,
				})),
			)
			.execute();

		const counter = new QueryCountingPlugin();
		const db = ctx.db.withPlugin(counter);
		const footer = await getMenuWithDb("footer", db, { locale: "fr" });
		const social = await getMenuWithDb("social", db, { locale: "fr" });
		const empty = await getMenuWithDb("empty", db, { locale: "fr" });
		const missing = await getMenuWithDb("missing", db, { locale: "fr" });

		expect(footer?.label).toBe("Pied de page");
		expect(footer?.items.map((item) => item.label)).toEqual(["Mentions", "Contact"]);
		expect(social?.locale).toBe("en");
		expect(social?.items.map((item) => item.label)).toEqual(["Mastodon"]);
		expect(empty?.items).toEqual([]);
		expect(missing).toBeNull();
		expect(counter.count).toBe(4);
	});
});
