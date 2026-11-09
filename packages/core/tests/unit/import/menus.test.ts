import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WxrNavMenuItem } from "../../../src/cli/wxr/parser.js";
import { MenuRepository } from "../../../src/database/repositories/menu.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import {
	importMenusFromPlugin,
	importMenusFromWxr,
	type WxrMenuArchive,
	type WxrMenuTarget,
} from "../../../src/import/menus.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("importMenusFromPlugin", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it.each([
		["team-member", "team_member"],
		["event", "events"],
		["post", "articles"],
	])(
		"links menu items for %s entries to the %s collection they were imported into",
		async (postType, collection) => {
			await new SchemaRegistry(db).createCollection({
				slug: collection,
				label: collection,
				labelSingular: collection,
			});
			await db
				.insertInto(`ec_${collection}` as never)
				.values({
					id: "entry-1",
					slug: "jane",
					status: "published",
					locale: "en",
					translation_group: "entry-1",
				} as never)
				.execute();

			await importMenusFromPlugin(
				[
					{
						id: 1,
						name: "primary",
						label: "Primary",
						items: [
							{
								id: 10,
								parent_id: null,
								sort_order: 0,
								type: "post_type",
								object: postType,
								object_id: 42,
								url: "https://wp.example/jane/",
								title: "Jane",
								target: null,
								classes: null,
							},
						],
					},
				],
				db,
				new Map([[42, "entry-1"]]),
				new Map([[42, collection]]),
			);

			const menu = await getMenuWithDb("primary", db);
			expect(menu?.items).toEqual([
				expect.objectContaining({ label: "Jane", url: `/${collection}/jane` }),
			]);
		},
	);
});

/** A WXR menu item linking to a page, unless `fields` says otherwise. */
function wxrItem(id: number, fields: Partial<WxrNavMenuItem> = {}): WxrNavMenuItem {
	return {
		id,
		menuId: 5,
		sortOrder: id,
		type: "post_type",
		objectType: "page",
		title: "",
		...fields,
	};
}

describe("importMenusFromWxr", () => {
	let db: Kysely<Database>;

	/** Entries the content import created, by WordPress post ID. */
	const targets = new Map<number, WxrMenuTarget>([
		[10, { collection: "pages", translationGroup: "about", locale: "en", title: "About us" }],
		[11, { collection: "pages", translationGroup: "team", locale: "en", title: "Team" }],
		[12, { collection: "events", translationGroup: "fair", locale: "en", title: "Spring fair" }],
		[20, { collection: "pages", translationGroup: "about", locale: "fr", title: "À propos" }],
	]);

	beforeEach(async () => {
		db = await setupTestDatabase();
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		const registry = new SchemaRegistry(db);
		for (const slug of ["pages", "events"]) {
			await registry.createCollection({ slug, label: slug, labelSingular: slug });
		}
		await db
			.insertInto("ec_pages" as never)
			.values([
				{
					id: "about-en",
					slug: "about",
					status: "published",
					locale: "en",
					translation_group: "about",
				},
				{
					id: "about-fr",
					slug: "a-propos",
					status: "published",
					locale: "fr",
					translation_group: "about",
				},
				{
					id: "team-en",
					slug: "team",
					status: "published",
					locale: "en",
					translation_group: "team",
				},
			] as never)
			.execute();
		await db
			.insertInto("ec_events" as never)
			.values({
				id: "fair-en",
				slug: "fair",
				status: "published",
				locale: "en",
				translation_group: "fair",
			} as never)
			.execute();
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownTestDatabase(db);
	});

	it("links items to the imported entries, nested as in WordPress, with the entry's title for an item without a label", async () => {
		const result = await importMenusFromWxr(
			[
				{
					id: 5,
					name: "primary",
					label: "Main navigation",
					items: [
						wxrItem(1, { objectId: 10 }),
						wxrItem(2, { objectId: 11, parentId: 1, title: "Our team" }),
						wxrItem(3, {
							type: "custom",
							objectType: "custom",
							url: "https://tickets.example/",
							title: "Tickets",
							target: "_blank",
						}),
						wxrItem(4, { objectId: 12, objectType: "event" }),
					],
				},
			],
			db,
			targets,
			"en",
		);

		expect(result).toMatchObject({
			menusCreated: 1,
			itemsCreated: 4,
			menusSkipped: 0,
			itemsSkipped: 0,
			errors: [],
		});
		const menu = await getMenuWithDb("primary", db);
		expect(menu).toMatchObject({ label: "Main navigation", locale: "en" });
		expect(menu?.items).toEqual([
			expect.objectContaining({
				label: "About us",
				url: "/pages/about",
				children: [expect.objectContaining({ label: "Our team", url: "/pages/team" })],
			}),
			expect.objectContaining({
				label: "Tickets",
				url: "https://tickets.example/",
				target: "_blank",
			}),
			expect.objectContaining({ label: "Spring fair", url: "/events/fair" }),
		]);
		// Items keep the entry's translation group, as menu items made in the admin do
		const rows = await db
			.selectFrom("_emdash_menu_items")
			.select(["type", "reference_collection", "reference_id", "locale"])
			.orderBy("sort_order")
			.execute();
		expect(rows).toEqual([
			{ type: "page", reference_collection: "pages", reference_id: "about", locale: "en" },
			{ type: "page", reference_collection: "pages", reference_id: "team", locale: "en" },
			{ type: "custom", reference_collection: null, reference_id: null, locale: "en" },
			{ type: "collection", reference_collection: "events", reference_id: "fair", locale: "en" },
		]);
	});

	it("gives each menu the locale of the entries it links to", async () => {
		await importMenusFromWxr(
			[
				{ id: 5, name: "primary", label: "Main navigation", items: [wxrItem(1, { objectId: 10 })] },
				{
					id: 6,
					name: "primary-fr",
					label: "Navigation principale",
					items: [
						wxrItem(2, { objectId: 20 }),
						wxrItem(3, { type: "custom", objectType: "custom", url: "/contact", title: "Contact" }),
					],
				},
			],
			db,
			targets,
			"en",
		);

		const menus = await db
			.selectFrom("_emdash_menus")
			.select(["name", "locale"])
			.orderBy("name")
			.execute();
		expect(menus).toEqual([
			{ name: "primary", locale: "en" },
			{ name: "primary-fr", locale: "fr" },
		]);
		const french = await getMenuWithDb("primary-fr", db, { locale: "fr" });
		expect(french?.items[0]).toMatchObject({
			label: "À propos",
			url: expect.stringContaining("a-propos"),
		});
	});

	it("gives a menu the default locale when its entries don't share one", async () => {
		await importMenusFromWxr(
			[
				{
					id: 5,
					name: "mixed",
					label: "Mixed",
					items: [wxrItem(1, { objectId: 10 }), wxrItem(2, { objectId: 20 })],
				},
				{
					id: 6,
					name: "links",
					label: "Links",
					items: [
						wxrItem(3, { type: "custom", objectType: "custom", url: "/contact", title: "Contact" }),
					],
				},
			],
			db,
			targets,
			"fr",
		);

		const menus = await db
			.selectFrom("_emdash_menus")
			.select(["name", "locale"])
			.orderBy("name")
			.execute();
		expect(menus).toEqual([
			{ name: "links", locale: "fr" },
			{ name: "mixed", locale: "fr" },
		]);
	});

	it("leaves out an item whose link is lost and moves its children up to its parent", async () => {
		const result = await importMenusFromWxr(
			[
				{
					id: 5,
					name: "primary",
					label: "Main navigation",
					items: [
						wxrItem(1, { objectId: 10 }),
						// A page the import left out
						wxrItem(2, { objectId: 99, parentId: 1 }),
						wxrItem(3, { objectId: 11, parentId: 2 }),
						// WordPress stores no address for a taxonomy archive link
						wxrItem(4, { type: "taxonomy", objectType: "category", objectId: 7, title: "News" }),
					],
				},
			],
			db,
			targets,
			"en",
		);

		expect(result).toMatchObject({ menusCreated: 1, itemsCreated: 2, itemsSkipped: 2 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toEqual([
			expect.objectContaining({
				label: "About us",
				children: [expect.objectContaining({ label: "Team" })],
			}),
		]);
	});

	it("links an item for a post type archive to its collection's archive, with the collection's label for an item without a label", async () => {
		const archives = new Map<string, WxrMenuArchive>([
			["event", { collection: "events", label: "Events" }],
		]);

		const result = await importMenusFromWxr(
			[
				{
					id: 5,
					name: "primary",
					label: "Main navigation",
					items: [
						// WordPress stores no address for an archive link, and no label unless it has its own
						wxrItem(1, { type: "post_type_archive", objectType: "event" }),
						wxrItem(2, { type: "post_type_archive", objectType: "event", title: "What's on" }),
						// A post type the import left out
						wxrItem(3, { type: "post_type_archive", objectType: "product", title: "Shop" }),
					],
				},
			],
			db,
			targets,
			"en",
			archives,
		);

		expect(result).toMatchObject({ menusCreated: 1, itemsCreated: 2, itemsSkipped: 1 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toEqual([
			expect.objectContaining({ label: "Events", url: "/events/" }),
			expect.objectContaining({ label: "What's on", url: "/events/" }),
		]);
	});

	it("leaves out Polylang's language switcher and keeps other custom links", async () => {
		const result = await importMenusFromWxr(
			[
				{
					id: 5,
					name: "primary",
					label: "Main navigation",
					items: [
						wxrItem(1, { objectId: 10 }),
						// What Polylang's language switcher box adds to a menu
						wxrItem(2, {
							type: "custom",
							objectType: "custom",
							url: "#pll_switcher",
							title: "Languages",
						}),
						wxrItem(3, { type: "custom", objectType: "custom", url: "#contact", title: "Contact" }),
					],
				},
			],
			db,
			targets,
			"en",
		);

		expect(result).toMatchObject({ itemsCreated: 2, itemsSkipped: 1 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toEqual([
			expect.objectContaining({ label: "About us" }),
			expect.objectContaining({ label: "Contact", url: "#contact" }),
		]);
	});

	it("keeps items whose parents form a cycle", async () => {
		const result = await importMenusFromWxr(
			[
				{
					id: 5,
					name: "primary",
					label: "Main navigation",
					items: [
						wxrItem(1, { objectId: 10, parentId: 2 }),
						wxrItem(2, { objectId: 11, parentId: 1 }),
					],
				},
			],
			db,
			targets,
			"en",
		);

		expect(result).toMatchObject({ itemsCreated: 2, itemsSkipped: 0 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toEqual([
			expect.objectContaining({
				label: "About us",
				children: [expect.objectContaining({ label: "Team" })],
			}),
		]);
	});

	it("leaves a menu alone when the site has one with the same name in that locale", async () => {
		await new MenuRepository(db).create({ name: "primary", label: "Seeded", locale: "en" });

		const result = await importMenusFromWxr(
			[{ id: 5, name: "primary", label: "Main navigation", items: [wxrItem(1, { objectId: 10 })] }],
			db,
			targets,
			"en",
		);

		expect(result).toMatchObject({ menusCreated: 0, menusSkipped: 1, itemsCreated: 0 });
		expect(await getMenuWithDb("primary", db)).toMatchObject({ label: "Seeded", items: [] });
	});
});
