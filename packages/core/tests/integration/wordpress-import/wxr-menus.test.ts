/**
 * Menus in a WXR import.
 *
 * The analysis lists an export's menus, and the admin offers to import them.
 * These tests run the analyze and execute routes the way the admin does and
 * check that the menus arrive with their labels, nesting and links.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as analyzePost } from "../../../src/astro/routes/api/import/wordpress/analyze.js";
import { POST as executePost } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { MenuRepository } from "../../../src/database/repositories/menu.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { handlersFromRuntime, createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type Handlers = ReturnType<typeof handlersFromRuntime>;

interface FixturePost {
	id: number;
	type: "page" | "post";
	slug: string;
	title: string;
	/** Parent page's post ID */
	parent?: number;
	/** Polylang language code */
	language?: string;
}

interface FixtureMenuItem {
	id: number;
	menu: string;
	order: number;
	type: "post_type" | "post_type_archive" | "custom" | "taxonomy";
	object?: string;
	objectId?: number;
	parent?: number;
	url?: string;
	title?: string;
}

function postXml(post: FixturePost): string {
	const language = post.language
		? `<category domain="language" nicename="${post.language}"><![CDATA[${post.language}]]></category>`
		: "";
	return `<item>
		<title>${post.title}</title>
		<wp:post_id>${post.id}</wp:post_id>
		<wp:post_type>${post.type}</wp:post_type>
		<wp:status>publish</wp:status>
		<wp:post_name>${post.slug}</wp:post_name>
		<wp:post_parent>${post.parent ?? 0}</wp:post_parent>
		<wp:post_date_gmt>2024-01-01 12:00:00</wp:post_date_gmt>
		<content:encoded><![CDATA[<p>${post.title}</p>]]></content:encoded>
		${language}
	</item>`;
}

function menuTermXml(id: number, slug: string, name: string): string {
	return `<wp:term>
		<wp:term_id>${id}</wp:term_id>
		<wp:term_taxonomy>nav_menu</wp:term_taxonomy>
		<wp:term_slug>${slug}</wp:term_slug>
		<wp:term_name><![CDATA[${name}]]></wp:term_name>
	</wp:term>`;
}

function menuItemXml(item: FixtureMenuItem): string {
	const meta = (key: string, value: string | number) =>
		`<wp:postmeta><wp:meta_key>${key}</wp:meta_key><wp:meta_value><![CDATA[${value}]]></wp:meta_value></wp:postmeta>`;
	return `<item>
		<title>${item.title ?? ""}</title>
		<wp:post_id>${item.id}</wp:post_id>
		<wp:post_type>nav_menu_item</wp:post_type>
		<wp:status>publish</wp:status>
		<wp:menu_order>${item.order}</wp:menu_order>
		<category domain="nav_menu" nicename="${item.menu}"><![CDATA[${item.menu}]]></category>
		${meta("_menu_item_type", item.type)}
		${meta("_menu_item_menu_item_parent", item.parent ?? 0)}
		${meta("_menu_item_object_id", item.objectId ?? item.id)}
		${meta("_menu_item_object", item.object ?? item.type)}
		${meta("_menu_item_url", item.url ?? "")}
	</item>`;
}

function makeWxr(parts: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
	<channel>
		<title>Test Site</title>
		<link>https://example.com</link>
		${parts.join("\n")}
	</channel>
</rss>`;
}

/** Pages and a post, with a menu that links to them the ways WordPress menus do. */
const SITE = makeWxr([
	menuTermXml(50, "primary", "Main navigation"),
	postXml({ id: 10, type: "page", slug: "about", title: "About" }),
	postXml({ id: 11, type: "page", slug: "team", title: "Team" }),
	postXml({ id: 20, type: "post", slug: "hello-world", title: "Hello world" }),
	// No label of its own: WordPress shows the page's title
	menuItemXml({
		id: 101,
		menu: "primary",
		order: 1,
		type: "post_type",
		object: "page",
		objectId: 10,
	}),
	menuItemXml({
		id: 102,
		menu: "primary",
		order: 2,
		type: "post_type",
		object: "page",
		objectId: 11,
		parent: 101,
		title: "Our team",
	}),
	menuItemXml({
		id: 103,
		menu: "primary",
		order: 3,
		type: "custom",
		url: "https://tickets.example/",
		title: "Tickets",
	}),
	menuItemXml({
		id: 104,
		menu: "primary",
		order: 4,
		type: "post_type",
		object: "post",
		objectId: 20,
	}),
	// A category archive: WordPress stores no address for it
	menuItemXml({
		id: 105,
		menu: "primary",
		order: 5,
		type: "taxonomy",
		object: "category",
		objectId: 7,
		title: "News",
	}),
]);

async function setup(): Promise<{ db: Kysely<Database>; emdash: Handlers }> {
	const db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);
	for (const [slug, label, labelSingular] of [
		["pages", "Pages", "Page"],
		["posts", "Posts", "Post"],
	] as const) {
		await registry.createCollection({ slug, label, labelSingular });
		await registry.createField(slug, { slug: "title", label: "Title", type: "string" });
		await registry.createField(slug, { slug: "content", label: "Content", type: "portableText" });
		await registry.createField(slug, { slug: "excerpt", label: "Excerpt", type: "text" });
	}
	return { db, emdash: handlersFromRuntime(createTestRuntime(db)) };
}

async function execute(
	emdash: Handlers,
	wxr: string,
	options: {
		config?: Record<string, unknown>;
		phase?: string;
		cursor?: unknown;
		chunk?: unknown;
	} = {},
) {
	const formData = new FormData();
	formData.append("file", new File([wxr], "export.xml", { type: "text/xml" }));
	formData.append(
		"config",
		JSON.stringify({
			postTypeMappings: {
				page: { collection: "pages", enabled: true },
				post: { collection: "posts", enabled: true },
			},
			skipExisting: true,
			...options.config,
		}),
	);
	if (options.phase) formData.append("phase", options.phase);
	if (options.cursor) formData.append("cursor", JSON.stringify(options.cursor));
	if (options.chunk) formData.append("chunk", JSON.stringify(options.chunk));
	const response = await executePost({
		request: new Request("http://localhost/_emdash/api/import/wordpress/execute", {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
			body: formData,
		}),
		locals: { emdash, user: { id: "test-admin", role: 50 } },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the route reads only request and locals
	} as never);
	expect(response.status).toBe(200);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- apiSuccess wraps the route's result in `data`
	return ((await response.json()) as { data: Record<string, any> }).data;
}

/** Run a chunked import the way the admin does: taxonomies, content chunks, then finalize. */
async function executeChunked(emdash: Handlers, wxr: string) {
	const prepared = await execute(emdash, wxr, { phase: "taxonomy" });
	let { cursor, chunk } = prepared;
	let done = false;
	while (!done) {
		const step = await execute(emdash, wxr, { phase: "content", cursor, chunk });
		({ cursor, chunk, done } = step);
	}
	return execute(emdash, wxr, { phase: "finalize", cursor, chunk });
}

describe("WXR import of menus", () => {
	let db: Kysely<Database>;
	let emdash: Handlers;

	beforeEach(async () => {
		({ db, emdash } = await setup());
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownTestDatabase(db);
	});

	it("imports the export's menus with their labels, nesting and links", async () => {
		const result = await execute(emdash, SITE);

		expect(result.menus).toEqual({ created: 1, items: 4, skipped: 0, itemsSkipped: 1 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.label).toBe("Main navigation");
		expect(menu?.items).toEqual([
			expect.objectContaining({
				label: "About",
				url: "/pages/about",
				children: [expect.objectContaining({ label: "Our team", url: "/pages/team" })],
			}),
			expect.objectContaining({ label: "Tickets", url: "https://tickets.example/" }),
			expect.objectContaining({ label: "Hello world", url: "/posts/hello-world" }),
		]);
	});

	it("imports the menus when a chunked import finishes, linking entries from every chunk", async () => {
		const pages = Array.from({ length: 31 }, (_, i) =>
			postXml({ id: i + 1, type: "page", slug: `page-${i + 1}`, title: `Page ${i + 1}` }),
		);
		const wxr = makeWxr([
			menuTermXml(50, "primary", "Main navigation"),
			...pages,
			menuItemXml({
				id: 101,
				menu: "primary",
				order: 1,
				type: "post_type",
				object: "page",
				objectId: 1,
			}),
			menuItemXml({
				id: 102,
				menu: "primary",
				order: 2,
				type: "post_type",
				object: "page",
				objectId: 31,
			}),
		]);

		const finalized = await executeChunked(emdash, wxr);

		expect(finalized.result.menus).toEqual({ created: 1, items: 2, skipped: 0, itemsSkipped: 0 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toEqual([
			expect.objectContaining({ label: "Page 1", url: "/pages/page-1" }),
			expect.objectContaining({ label: "Page 31", url: "/pages/page-31" }),
		]);
	});

	it.each([
		["both pages", [12, 13]],
		["only the page the import leaves out", [13]],
	])(
		"leaves out links to pages that share a slug, since one entry can't stand for both: %s",
		async (_case, linked) => {
			// WordPress lets pages under different parents share a slug: services/support and products/support
			const wxr = makeWxr([
				menuTermXml(50, "primary", "Main navigation"),
				postXml({ id: 10, type: "page", slug: "services", title: "Services" }),
				postXml({ id: 11, type: "page", slug: "products", title: "Products" }),
				postXml({ id: 12, type: "page", slug: "support", title: "Service support", parent: 10 }),
				postXml({ id: 13, type: "page", slug: "support", title: "Product support", parent: 11 }),
				menuItemXml({
					id: 101,
					menu: "primary",
					order: 1,
					type: "post_type",
					object: "page",
					objectId: 10,
				}),
				...linked.map((objectId, index) =>
					menuItemXml({
						id: 102 + index,
						menu: "primary",
						order: 2 + index,
						type: "post_type",
						object: "page",
						objectId,
					}),
				),
			]);

			const result = await execute(emdash, wxr);

			// The content import creates the first support page and skips the second
			expect(result).toMatchObject({ imported: 3, skipped: 1 });
			expect(result.menus).toEqual({
				created: 1,
				items: 1,
				skipped: 0,
				itemsSkipped: linked.length,
			});
			const menu = await getMenuWithDb("primary", db);
			expect(menu?.items).toEqual([
				expect.objectContaining({ label: "Services", url: "/pages/services" }),
			]);
		},
	);

	it("links an item for a post type archive to the archive of that post type's collection", async () => {
		const wxr = makeWxr([
			menuTermXml(50, "primary", "Main navigation"),
			postXml({ id: 20, type: "post", slug: "hello-world", title: "Hello world" }),
			// WordPress stores no address for an archive link, and no label unless it has its own
			menuItemXml({
				id: 101,
				menu: "primary",
				order: 1,
				type: "post_type_archive",
				object: "post",
			}),
			menuItemXml({
				id: 102,
				menu: "primary",
				order: 2,
				type: "post_type_archive",
				object: "post",
				title: "Blog",
			}),
			// A post type the import leaves out
			menuItemXml({
				id: 103,
				menu: "primary",
				order: 3,
				type: "post_type_archive",
				object: "event",
				title: "Events",
			}),
		]);

		const result = await execute(emdash, wxr);

		expect(result.menus).toEqual({ created: 1, items: 2, skipped: 0, itemsSkipped: 1 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toEqual([
			expect.objectContaining({ label: "Posts", url: "/posts/" }),
			expect.objectContaining({ label: "Blog", url: "/posts/" }),
		]);
	});

	it("leaves the menus out when the import is told to", async () => {
		const result = await execute(emdash, SITE, { config: { importMenus: false } });

		expect(result.menus).toBeUndefined();
		expect(await db.selectFrom("_emdash_menus").select("id").execute()).toEqual([]);
	});

	it("reports a failed menu step with the rest of the result", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();

		// A locale the site doesn't have stops the menus, after the content step
		const result = await execute(emdash, SITE, { config: { locale: "de" } });

		expect(result.success).toBe(false);
		expect(result.errors).toContainEqual({ title: "Menus", error: "Failed to import menus" });
		expect(result.menus).toBeUndefined();
	});

	it("reports a menu that fails without the failure's detail, and leaves no part of it", async () => {
		const setItems = vi
			.spyOn(MenuRepository.prototype, "setItems")
			.mockRejectedValueOnce(
				new Error("D1_ERROR: UNIQUE constraint failed: _emdash_menu_items.id"),
			);
		try {
			const result = await execute(emdash, SITE);

			expect(result.imported).toBe(3);
			expect(result.success).toBe(false);
			expect(result.errors).toEqual([{ title: "Menu: primary", error: "Failed to import menu" }]);
			expect(JSON.stringify(result)).not.toContain("D1_ERROR");
			// Nothing is left that would make importing the export again skip the menu
			expect(await db.selectFrom("_emdash_menus").select("id").execute()).toEqual([]);
		} finally {
			setItems.mockRestore();
		}
	});

	it("lists the export's menus by their names in WordPress in the analysis", async () => {
		const formData = new FormData();
		formData.append("file", new File([SITE], "export.xml", { type: "text/xml" }));
		const response = await analyzePost({
			request: new Request("http://localhost/_emdash/api/import/wordpress/analyze", {
				method: "POST",
				body: formData,
			}),
			locals: { emdash, user: { id: "test-admin", role: 50 } },
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the route reads only request and locals
		} as never);

		expect(response.status).toBe(200);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- apiSuccess wraps the analysis in `data`
		const { data } = (await response.json()) as { data: { navMenus?: unknown } };
		expect(data.navMenus).toEqual([{ name: "primary", label: "Main navigation", itemCount: 5 }]);
	});

	it("leaves an imported menu as it is when the same export is imported again", async () => {
		await execute(emdash, SITE);

		const again = await execute(emdash, SITE);

		expect(again.menus).toEqual({ created: 0, items: 0, skipped: 1, itemsSkipped: 0 });
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toHaveLength(3);
	});

	it("gives each language's menu the locale of its pages on a site translated with Polylang", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		const wxr = makeWxr([
			menuTermXml(50, "primary", "Main navigation"),
			menuTermXml(51, "primary-fr", "Navigation principale"),
			postXml({ id: 10, type: "page", slug: "about", title: "About", language: "en" }),
			postXml({ id: 11, type: "page", slug: "a-propos", title: "À propos", language: "fr" }),
			menuItemXml({
				id: 101,
				menu: "primary",
				order: 1,
				type: "post_type",
				object: "page",
				objectId: 10,
			}),
			menuItemXml({
				id: 102,
				menu: "primary-fr",
				order: 1,
				type: "post_type",
				object: "page",
				objectId: 11,
			}),
			// Polylang's language switcher, which only Polylang turns into language links
			menuItemXml({
				id: 103,
				menu: "primary",
				order: 2,
				type: "custom",
				url: "#pll_switcher",
				title: "Languages",
			}),
		]);

		const result = await execute(emdash, wxr);

		expect(result.menus).toMatchObject({ created: 2, items: 2, itemsSkipped: 1 });
		const menus = await db
			.selectFrom("_emdash_menus")
			.select(["name", "label", "locale"])
			.orderBy("name")
			.execute();
		expect(menus).toEqual([
			{ name: "primary", label: "Main navigation", locale: "en" },
			{ name: "primary-fr", label: "Navigation principale", locale: "fr" },
		]);
		const french = await getMenuWithDb("primary-fr", db, { locale: "fr" });
		expect(french?.items).toEqual([
			expect.objectContaining({ label: "À propos", url: expect.stringContaining("a-propos") }),
		]);
	});
});
