/**
 * Regression tests for importing WordPress navigation menus and site
 * settings from a WXR export.
 *
 * Before the fix, nav_menu_item posts and the channel-level title/tagline
 * were silently dropped during import, so the target site ended up with
 * no menus and a blank site title.
 */

import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	collectInternalHosts,
	importNavMenus,
	importSiteSettings,
	rewriteInternalLinks,
	type ImportedRef,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { WxrData } from "../../../src/cli/wxr/parser.js";
import type { Database } from "../../../src/database/types.js";
import { getSiteSettingsWithDb } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function makeWxr(overrides: Partial<WxrData> = {}): WxrData {
	return {
		site: {},
		posts: [],
		attachments: [],
		categories: [],
		tags: [],
		authors: [],
		terms: [],
		navMenus: [],
		...overrides,
	};
}

describe("WordPress menu import", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("creates menus and menu items, linking to imported pages", async () => {
		const wxr = makeWxr({
			terms: [{ id: 5, taxonomy: "nav_menu", slug: "primary", name: "Primary" }],
			navMenus: [
				{
					id: 5,
					name: "primary",
					label: "primary",
					items: [
						{
							id: 101,
							menuId: 5,
							sortOrder: 0,
							type: "post_type",
							objectType: "page",
							objectId: 6,
							title: "Home",
						},
						{
							id: 102,
							menuId: 5,
							sortOrder: 1,
							type: "custom",
							url: "https://example.com/apply",
							title: "Apply Now",
						},
					],
				},
			],
		});

		const wpPostIdToImported = new Map<number, ImportedRef>([
			[6, { collection: "pages", contentId: "page-abc", slug: "home", title: "Home" }],
		]);

		const result = await importNavMenus(db, wxr, wpPostIdToImported);

		expect(result).toEqual({ created: 1, items: 2, replaced: 0 });

		const menu = await db
			.selectFrom("_emdash_menus")
			.selectAll()
			.where("name", "=", "primary")
			.executeTakeFirstOrThrow();
		expect(menu.label).toBe("Primary");

		const items = await db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("menu_id", "=", menu.id)
			.orderBy("sort_order", "asc")
			.execute();

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			type: "page",
			label: "Home",
			reference_collection: "pages",
			reference_id: "page-abc",
		});
		expect(items[1]).toMatchObject({
			type: "custom",
			label: "Apply Now",
			custom_url: "https://example.com/apply",
		});
	});

	it("uses the page's title when the menu item title is empty", async () => {
		// WordPress stores an empty title when the menu item should render
		// the current title of the linked page.
		const wxr = makeWxr({
			navMenus: [
				{
					id: 5,
					name: "primary",
					label: "Primary",
					items: [
						{
							id: 101,
							menuId: 5,
							sortOrder: 0,
							type: "post_type",
							objectType: "page",
							objectId: 3,
							title: "",
						},
					],
				},
			],
		});

		const wpPostIdToImported = new Map<number, ImportedRef>([
			[3, { collection: "pages", contentId: "page-xyz", slug: "blog", title: "Articles" }],
		]);

		await importNavMenus(db, wxr, wpPostIdToImported);

		const item = await db
			.selectFrom("_emdash_menu_items")
			.select("label")
			.executeTakeFirstOrThrow();
		expect(item.label).toBe("Articles");
	});

	it("falls back to a custom URL when a referenced page wasn't imported", async () => {
		const wxr = makeWxr({
			navMenus: [
				{
					id: 5,
					name: "primary",
					label: "Primary",
					items: [
						{
							id: 201,
							menuId: 5,
							sortOrder: 0,
							type: "post_type",
							objectType: "page",
							objectId: 999,
							url: "https://example.com/missing/",
							title: "Missing",
						},
					],
				},
			],
		});

		await importNavMenus(db, wxr, new Map());

		const items = await db.selectFrom("_emdash_menu_items").selectAll().execute();
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("custom");
		expect(items[0]?.custom_url).toBe("https://example.com/missing/");
	});

	it("replaces an existing menu with the same name on re-import", async () => {
		const wxr = makeWxr({
			navMenus: [
				{
					id: 5,
					name: "primary",
					label: "Primary",
					items: [{ id: 301, menuId: 5, sortOrder: 0, type: "custom", url: "/a", title: "A" }],
				},
			],
		});

		await importNavMenus(db, wxr, new Map());
		const second = await importNavMenus(db, wxr, new Map());

		expect(second.replaced).toBe(1);
		const menus = await db.selectFrom("_emdash_menus").selectAll().execute();
		expect(menus).toHaveLength(1);

		// Cascade on delete means the old item is gone and we have exactly one again.
		const items = await db.selectFrom("_emdash_menu_items").selectAll().execute();
		expect(items).toHaveLength(1);
	});
});

describe("rewriteInternalLinks", () => {
	const hosts = collectInternalHosts(
		makeWxr({
			site: {
				link: "https://adambuice.com",
				baseBlogUrl: "https://adambuice.com",
			},
		}),
	);

	it("strips the source site host from button URLs inside PortableText", () => {
		const blocks = [
			{
				_type: "buttons",
				_key: "k1",
				buttons: [
					{
						_type: "button",
						_key: "k2",
						text: "Who I Work With",
						url: "https://adambuice.com/who-i-work-with/",
					},
				],
			},
		];

		const out = rewriteInternalLinks(blocks, hosts) as typeof blocks;
		expect(out[0]?.buttons[0]?.url).toBe("/who-i-work-with/");
	});

	it("rewrites link marks in text spans", () => {
		const blocks = [
			{
				_type: "block",
				_key: "b1",
				children: [{ _type: "span", _key: "s1", text: "blog", marks: ["m1"] }],
				markDefs: [{ _type: "link", _key: "m1", href: "https://adambuice.com/blog/" }],
			},
		];

		const out = rewriteInternalLinks(blocks, hosts) as typeof blocks;
		expect(out[0]?.markDefs?.[0]?.href).toBe("/blog/");
	});

	it("leaves external URLs untouched", () => {
		const blocks = [
			{
				_type: "button",
				_key: "b1",
				text: "Apply",
				url: "https://myloan.migonline.com/apply/welcome?userid=adam.buice",
			},
		];

		const out = rewriteInternalLinks(blocks, hosts) as typeof blocks;
		expect(out[0]?.url).toBe("https://myloan.migonline.com/apply/welcome?userid=adam.buice");
	});

	it("does not rewrite image asset URLs or linked-image hrefs", () => {
		// Media URLs stay absolute — they get remapped to R2 by the separate
		// media-import / URL-rewrite step.
		const blocks = [
			{
				_type: "image",
				_key: "i1",
				asset: {
					_type: "reference",
					_ref: "https://adambuice.com/wp-content/uploads/ab-1.jpg",
					url: "https://adambuice.com/wp-content/uploads/ab-1.jpg",
				},
				link: "https://adambuice.com/about/",
			},
			{
				_type: "gallery",
				_key: "g1",
				images: [
					{
						_type: "image",
						_key: "gi1",
						asset: {
							_type: "reference",
							_ref: "https://adambuice.com/wp-content/uploads/ab-2.jpg",
							url: "https://adambuice.com/wp-content/uploads/ab-2.jpg",
						},
					},
				],
			},
		];

		const out = rewriteInternalLinks(blocks, hosts) as typeof blocks;
		expect(out[0]?.asset?.url).toBe("https://adambuice.com/wp-content/uploads/ab-1.jpg");
		expect(out[0]?.asset?._ref).toBe("https://adambuice.com/wp-content/uploads/ab-1.jpg");
		expect(out[0]?.link).toBe("https://adambuice.com/about/");
		expect(out[1]?.images?.[0]?.asset?.url).toBe(
			"https://adambuice.com/wp-content/uploads/ab-2.jpg",
		);
	});

	it("is a no-op when no internal hosts are configured", () => {
		const blocks = [
			{
				_type: "button",
				_key: "b1",
				url: "https://adambuice.com/anywhere/",
			},
		];
		const out = rewriteInternalLinks(blocks, new Set<string>()) as typeof blocks;
		expect(out[0]?.url).toBe("https://adambuice.com/anywhere/");
	});
});

describe("WordPress site settings import", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("writes title, tagline and url from the channel header", async () => {
		const wxr = makeWxr({
			site: {
				title: "Adam Buice",
				description: "North Atlanta Mortgage Specialist",
				link: "https://adambuice.com",
				baseBlogUrl: "https://adambuice.com",
			},
		});

		const applied = await importSiteSettings(db, wxr);
		expect(applied.toSorted()).toEqual(["tagline", "title", "url"]);

		const settings = await getSiteSettingsWithDb(db);
		expect(settings.title).toBe("Adam Buice");
		expect(settings.tagline).toBe("North Atlanta Mortgage Specialist");
		expect(settings.url).toBe("https://adambuice.com");
	});

	it("is a no-op when the channel has no metadata", async () => {
		const applied = await importSiteSettings(db, makeWxr());
		expect(applied).toEqual([]);
		const settings = await getSiteSettingsWithDb(db);
		expect(settings.title).toBeUndefined();
	});
});
