import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("applySeed", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("validation", () => {
		it("should reject invalid seed file", async () => {
			const invalidSeed = { version: "99" } as SeedFile;

			await expect(applySeed(db, invalidSeed)).rejects.toThrow("Invalid seed file");
		});

		it("should accept minimal valid seed", async () => {
			const seed: SeedFile = { version: "1" };

			const result = await applySeed(db, seed);

			expect(result.collections.created).toBe(0);
			expect(result.settings.applied).toBe(0);
		});
	});

	describe("settings", () => {
		it("should apply site settings", async () => {
			const seed: SeedFile = {
				version: "1",
				settings: {
					siteTitle: "Test Site",
					tagline: "A test site",
				},
			};

			const result = await applySeed(db, seed);

			expect(result.settings.applied).toBe(2);

			// Verify settings were saved
			const row = await db
				.selectFrom("options")
				.selectAll()
				.where("name", "=", "site:siteTitle")
				.executeTakeFirst();

			expect(row?.value).toBe('"Test Site"');
		});
	});

	describe("collections", () => {
		it("should create collections and fields", async () => {
			const seed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						labelSingular: "Post",
						fields: [
							{ slug: "title", label: "Title", type: "string", required: true },
							{ slug: "content", label: "Content", type: "portableText" },
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.collections.created).toBe(1);
			expect(result.fields.created).toBe(2);

			// Verify collection exists
			const registry = new SchemaRegistry(db);
			const collection = await registry.getCollection("posts");
			expect(collection).not.toBeNull();
			expect(collection?.label).toBe("Posts");
		});

		it("should skip existing collections", async () => {
			// Create collection first
			const registry = new SchemaRegistry(db);
			await registry.createCollection({
				slug: "posts",
				label: "Existing Posts",
			});

			const seed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "New Posts",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.collections.created).toBe(0);
			expect(result.collections.skipped).toBe(1);
			expect(result.fields.skipped).toBe(1);

			// Original label should be preserved
			const collection = await registry.getCollection("posts");
			expect(collection?.label).toBe("Existing Posts");
		});

		it("should create multiple collections", async () => {
			const seed: SeedFile = {
				version: "1",
				collections: [
					{ slug: "posts", label: "Posts", fields: [] },
					{ slug: "pages", label: "Pages", fields: [] },
					{ slug: "products", label: "Products", fields: [] },
				],
			};

			const result = await applySeed(db, seed);

			expect(result.collections.created).toBe(3);
		});
	});

	describe("taxonomies", () => {
		it("should create taxonomy definitions", async () => {
			const seed: SeedFile = {
				version: "1",
				taxonomies: [
					{
						name: "topics",
						label: "Topics",
						hierarchical: true,
						collections: ["posts"],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.taxonomies.created).toBe(1);

			// Verify taxonomy exists
			const row = await db
				.selectFrom("_emdash_taxonomy_defs")
				.selectAll()
				.where("name", "=", "topics")
				.executeTakeFirst();

			expect(row).not.toBeNull();
			expect(row?.label).toBe("Topics");
			expect(row?.hierarchical).toBe(1);
			expect(row?.translation_group).toBe(row?.id);
		});

		it("should create flat taxonomy terms", async () => {
			const seed: SeedFile = {
				version: "1",
				taxonomies: [
					{
						name: "tags",
						label: "Tags",
						hierarchical: false,
						collections: ["posts"],
						terms: [
							{ slug: "javascript", label: "JavaScript" },
							{ slug: "typescript", label: "TypeScript" },
							{ slug: "rust", label: "Rust" },
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.taxonomies.created).toBe(1);
			expect(result.taxonomies.terms).toBe(3);
		});

		it("should create hierarchical taxonomy terms with parents", async () => {
			const seed: SeedFile = {
				version: "1",
				taxonomies: [
					{
						name: "topics",
						label: "Topics",
						hierarchical: true,
						collections: ["posts"],
						terms: [
							{ slug: "tech", label: "Technology" },
							{ slug: "web", label: "Web Development", parent: "tech" },
							{ slug: "mobile", label: "Mobile Development", parent: "tech" },
							{ slug: "react", label: "React", parent: "web" },
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.taxonomies.terms).toBe(4);

			// Verify parent-child relationship
			const termRepo = new TaxonomyRepository(db);
			const webTerm = await termRepo.findBySlug("topics", "web");
			const techTerm = await termRepo.findBySlug("topics", "tech");

			expect(webTerm?.parentId).toBe(techTerm?.id);
		});

		it("should skip existing terms", async () => {
			// Create taxonomy and term first
			await db
				.insertInto("_emdash_taxonomy_defs")
				.values({
					id: "def-1",
					name: "tags",
					label: "Tags",
					hierarchical: 0,
					collections: JSON.stringify(["posts"]),
				})
				.execute();

			const termRepo = new TaxonomyRepository(db);
			await termRepo.create({
				name: "tags",
				slug: "javascript",
				label: "Existing JS",
			});

			const seed: SeedFile = {
				version: "1",
				taxonomies: [
					{
						name: "tags",
						label: "Tags",
						hierarchical: false,
						collections: ["posts"],
						terms: [
							{ slug: "javascript", label: "New JavaScript" },
							{ slug: "typescript", label: "TypeScript" },
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			// Definition already exists, so not created
			expect(result.taxonomies.created).toBe(0);
			// Only typescript is new
			expect(result.taxonomies.terms).toBe(1);

			// Original label should be preserved
			const term = await termRepo.findBySlug("tags", "javascript");
			expect(term?.label).toBe("Existing JS");
		});
	});

	describe("menus", () => {
		it("should create menus with items", async () => {
			const seed: SeedFile = {
				version: "1",
				menus: [
					{
						name: "main",
						label: "Main Navigation",
						items: [
							{ type: "custom", label: "Home", url: "/" },
							{ type: "custom", label: "About", url: "/about" },
							{ type: "custom", label: "Contact", url: "/contact" },
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.menus.created).toBe(1);
			expect(result.menus.items).toBe(3);

			// Verify menu exists
			const menu = await db
				.selectFrom("_emdash_menus")
				.selectAll()
				.where("name", "=", "main")
				.executeTakeFirst();

			expect(menu).not.toBeNull();
			expect(menu?.label).toBe("Main Navigation");
			expect(menu?.translation_group).toBe(menu?.id);

			const items = await db
				.selectFrom("_emdash_menu_items")
				.selectAll()
				.where("menu_id", "=", menu?.id ?? "")
				.execute();
			for (const item of items) {
				expect(item.translation_group, `item ${item.label}`).toBe(item.id);
			}
		});

		it("should create nested menu items", async () => {
			const seed: SeedFile = {
				version: "1",
				menus: [
					{
						name: "main",
						label: "Main",
						items: [
							{
								type: "custom",
								label: "Products",
								url: "/products",
								children: [
									{
										type: "custom",
										label: "Software",
										url: "/products/software",
									},
									{
										type: "custom",
										label: "Hardware",
										url: "/products/hardware",
									},
								],
							},
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.menus.items).toBe(3); // 1 parent + 2 children

			// Verify parent-child relationship
			const items = await db.selectFrom("_emdash_menu_items").selectAll().execute();

			const parent = items.find((i) => i.label === "Products");
			const child = items.find((i) => i.label === "Software");

			expect(child?.parent_id).toBe(parent?.id);
		});

		it("should replace items in existing menu", async () => {
			// Create menu with items first
			await db
				.insertInto("_emdash_menus")
				.values({
					id: "menu-1",
					name: "main",
					label: "Main",
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				})
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: "item-1",
					menu_id: "menu-1",
					parent_id: null,
					sort_order: 0,
					type: "custom",
					label: "Old Item",
					custom_url: "/old",
					created_at: new Date().toISOString(),
				})
				.execute();

			const seed: SeedFile = {
				version: "1",
				menus: [
					{
						name: "main",
						label: "Main",
						items: [{ type: "custom", label: "New Item", url: "/new" }],
					},
				],
			};

			const result = await applySeed(db, seed);

			// Menu not created (existed), but items are replaced
			expect(result.menus.created).toBe(0);
			expect(result.menus.items).toBe(1);

			// Old item should be gone
			const items = await db
				.selectFrom("_emdash_menu_items")
				.selectAll()
				.where("menu_id", "=", "menu-1")
				.execute();

			expect(items).toHaveLength(1);
			expect(items[0].label).toBe("New Item");
		});
	});

	describe("widget areas", () => {
		it("should create widget areas with widgets", async () => {
			const seed: SeedFile = {
				version: "1",
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						description: "The main sidebar",
						widgets: [
							{
								type: "content",
								title: "About",
								content: [{ _type: "block", children: [{ text: "About us" }] }],
							},
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.widgetAreas.created).toBe(1);
			expect(result.widgetAreas.widgets).toBe(1);

			// Verify area exists
			const area = await db
				.selectFrom("_emdash_widget_areas")
				.selectAll()
				.where("name", "=", "sidebar")
				.executeTakeFirst();

			expect(area).not.toBeNull();
			expect(area?.description).toBe("The main sidebar");
		});

		it("should create menu widgets", async () => {
			const seed: SeedFile = {
				version: "1",
				widgetAreas: [
					{
						name: "footer",
						label: "Footer",
						widgets: [{ type: "menu", title: "Footer Nav", menuName: "footer-menu" }],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.widgetAreas.widgets).toBe(1);

			const widget = await db.selectFrom("_emdash_widgets").selectAll().executeTakeFirst();

			expect(widget?.type).toBe("menu");
			expect(widget?.menu_name).toBe("footer-menu");
		});

		it("should create component widgets", async () => {
			const seed: SeedFile = {
				version: "1",
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						widgets: [
							{
								type: "component",
								componentId: "recent-posts",
								props: { count: 5, showDate: true },
							},
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.widgetAreas.widgets).toBe(1);

			const widget = await db.selectFrom("_emdash_widgets").selectAll().executeTakeFirst();

			expect(widget?.type).toBe("component");
			expect(widget?.component_id).toBe("recent-posts");
			expect(JSON.parse(widget?.component_props ?? "{}")).toEqual({
				count: 5,
				showDate: true,
			});
		});

		it("should replace widgets in existing area", async () => {
			// Create area with widget first
			await db
				.insertInto("_emdash_widget_areas")
				.values({
					id: "area-1",
					name: "sidebar",
					label: "Sidebar",
					description: null,
				})
				.execute();

			await db
				.insertInto("_emdash_widgets")
				.values({
					id: "widget-1",
					area_id: "area-1",
					sort_order: 0,
					type: "content",
					title: "Old Widget",
					content: null,
					menu_name: null,
					component_id: null,
					component_props: null,
				})
				.execute();

			const seed: SeedFile = {
				version: "1",
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						widgets: [{ type: "content", title: "New Widget" }],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.widgetAreas.created).toBe(0);
			expect(result.widgetAreas.widgets).toBe(1);

			// Old widget should be gone
			const widgets = await db
				.selectFrom("_emdash_widgets")
				.selectAll()
				.where("area_id", "=", "area-1")
				.execute();

			expect(widgets).toHaveLength(1);
			expect(widgets[0]!.title).toBe("New Widget");
		});
	});

	describe("redirects", () => {
		it("should create redirects", async () => {
			const seed: SeedFile = {
				version: "1",
				redirects: [
					{ source: "/old-about", destination: "/about" },
					{
						source: "/temp",
						destination: "/new-temp",
						type: 302,
						enabled: false,
						groupName: "migration",
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.redirects.created).toBe(2);
			expect(result.redirects.skipped).toBe(0);

			const redirects = await db
				.selectFrom("_emdash_redirects")
				.selectAll()
				.orderBy("source", "asc")
				.execute();

			expect(redirects).toHaveLength(2);
			expect(redirects[0]!.source).toBe("/old-about");
			expect(redirects[0]!.destination).toBe("/about");
			expect(redirects[0]!.type).toBe(301);
			expect(redirects[0]!.enabled).toBe(1);
			expect(redirects[1]!.source).toBe("/temp");
			expect(redirects[1]!.type).toBe(302);
			expect(redirects[1]!.enabled).toBe(0);
			expect(redirects[1]!.group_name).toBe("migration");
		});

		it("should skip redirects when source already exists", async () => {
			const redirectRepo = new RedirectRepository(db);
			await redirectRepo.create({
				source: "/old-about",
				destination: "/existing-about",
			});

			const seed: SeedFile = {
				version: "1",
				redirects: [
					{ source: "/old-about", destination: "/about" },
					{ source: "/old-contact", destination: "/contact" },
				],
			};

			const result = await applySeed(db, seed);

			expect(result.redirects.created).toBe(1);
			expect(result.redirects.skipped).toBe(1);

			const existing = await redirectRepo.findBySource("/old-about");
			expect(existing?.destination).toBe("/existing-about");

			const created = await redirectRepo.findBySource("/old-contact");
			expect(created?.destination).toBe("/contact");
		});
	});

	describe("content", () => {
		it("should create bylines and assign ordered credits to content", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const seed: SeedFile = {
				version: "1",
				bylines: [
					{ id: "editorial", slug: "editorial", displayName: "Editorial" },
					{ id: "guest", slug: "guest-writer", displayName: "Guest Writer", isGuest: true },
				],
				content: {
					posts: [
						{
							id: "post-1",
							slug: "hello",
							data: { title: "Hello World" },
							bylines: [{ byline: "editorial" }, { byline: "guest", roleLabel: "Guest essay" }],
						},
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.bylines.created).toBe(2);
			expect(result.content.created).toBe(1);

			const contentRepo = new ContentRepository(db);
			const bylineRepo = new BylineRepository(db);
			const entry = await contentRepo.findBySlug("posts", "hello");
			expect(entry).not.toBeNull();

			const credits = await bylineRepo.getContentBylines("posts", entry!.id);
			expect(credits).toHaveLength(2);
			expect(credits[0]?.byline.slug).toBe("editorial");
			expect(credits[1]?.byline.slug).toBe("guest-writer");
			expect(credits[1]?.roleLabel).toBe("Guest essay");
			expect(entry?.primaryBylineId).toBe(credits[0]?.byline.id);
		});

		it("should not create content by default", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const seed: SeedFile = {
				version: "1",
				content: {
					posts: [{ id: "post-1", slug: "hello", data: { title: "Hello World" } }],
				},
			};

			const result = await applySeed(db, seed);

			expect(result.content.created).toBe(0);

			const contentRepo = new ContentRepository(db);
			const entries = await contentRepo.findMany("posts", {});
			expect(entries.items).toHaveLength(0);
		});

		it("should create content when includeContent is true", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const seed: SeedFile = {
				version: "1",
				content: {
					posts: [
						{ id: "post-1", slug: "hello", data: { title: "Hello World" } },
						{ id: "post-2", slug: "goodbye", data: { title: "Goodbye World" } },
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.content.created).toBe(2);

			const contentRepo = new ContentRepository(db);
			const entry = await contentRepo.findBySlug("posts", "hello");
			expect(entry?.data.title).toBe("Hello World");
		});

		it("should skip existing content entries", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const contentRepo = new ContentRepository(db);
			await contentRepo.create({
				type: "posts",
				slug: "hello",
				data: { title: "Existing" },
			});

			const seed: SeedFile = {
				version: "1",
				content: {
					posts: [
						{ id: "post-1", slug: "hello", data: { title: "New Title" } },
						{ id: "post-2", slug: "world", data: { title: "World" } },
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.content.created).toBe(1);
			expect(result.content.skipped).toBe(1);

			// Original should be preserved
			const entry = await contentRepo.findBySlug("posts", "hello");
			expect(entry?.data.title).toBe("Existing");
		});

		it("should resolve $ref: references between content", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			await registry.createField("posts", {
				slug: "related_post",
				label: "Related Post",
				type: "reference",
			});

			const seed: SeedFile = {
				version: "1",
				content: {
					posts: [
						{ id: "post-1", slug: "first", data: { title: "First" } },
						{
							id: "post-2",
							slug: "second",
							data: { title: "Second", related_post: "$ref:post-1" },
						},
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.content.created).toBe(2);

			const contentRepo = new ContentRepository(db);
			const first = await contentRepo.findBySlug("posts", "first");
			const second = await contentRepo.findBySlug("posts", "second");

			// The reference should be resolved to the real ID
			expect(second?.data.related_post).toBe(first?.id);
		});

		it("should assign taxonomy terms to content", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			// Create taxonomy
			await db
				.insertInto("_emdash_taxonomy_defs")
				.values({
					id: "def-1",
					name: "tags",
					label: "Tags",
					hierarchical: 0,
					collections: JSON.stringify(["posts"]),
				})
				.execute();

			const termRepo = new TaxonomyRepository(db);
			await termRepo.create({ name: "tags", slug: "javascript", label: "JS" });
			await termRepo.create({ name: "tags", slug: "typescript", label: "TS" });

			const seed: SeedFile = {
				version: "1",
				content: {
					posts: [
						{
							id: "post-1",
							slug: "hello",
							data: { title: "Hello" },
							taxonomies: { tags: ["javascript", "typescript"] },
						},
					],
				},
			};

			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.content.created).toBe(1);

			// Check taxonomy assignments
			const contentRepo = new ContentRepository(db);
			const entry = await contentRepo.findBySlug("posts", "hello");

			const assignments = await db
				.selectFrom("content_taxonomies")
				.selectAll()
				.where("entry_id", "=", entry!.id)
				.execute();

			expect(assignments).toHaveLength(2);
		});
	});

	describe("apply order", () => {
		it("should create content before menus so refs resolve", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "pages", label: "Pages" });
			await registry.createField("pages", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const seed: SeedFile = {
				version: "1",
				content: {
					pages: [{ id: "about-page", slug: "about", data: { title: "About Us" } }],
				},
				menus: [
					{
						name: "main",
						label: "Main",
						items: [
							{
								type: "page",
								label: "About",
								ref: "about-page",
								collection: "pages",
							},
						],
					},
				],
			};

			const result = await applySeed(db, seed, { includeContent: true });

			expect(result.content.created).toBe(1);
			expect(result.menus.items).toBe(1);

			// Menu item should reference the content
			const contentRepo = new ContentRepository(db);
			const aboutPage = await contentRepo.findBySlug("pages", "about");

			const menuItem = await db.selectFrom("_emdash_menu_items").selectAll().executeTakeFirst();

			expect(menuItem?.reference_id).toBe(aboutPage?.id);
		});
	});

	describe("sections", () => {
		it("should create sections", async () => {
			const seed: SeedFile = {
				version: "1",
				sections: [
					{
						slug: "hero-centered",
						title: "Centered Hero",
						description: "A centered hero section",
						keywords: ["hero", "banner"],
						content: [
							{
								_type: "block",
								style: "h1",
								children: [{ _type: "span", text: "Welcome" }],
							},
						],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.sections.created).toBe(1);
			expect(result.sections.skipped).toBe(0);

			// Verify section exists
			const section = await db
				.selectFrom("_emdash_sections")
				.selectAll()
				.where("slug", "=", "hero-centered")
				.executeTakeFirst();

			expect(section).not.toBeNull();
			expect(section?.title).toBe("Centered Hero");
			expect(section?.description).toBe("A centered hero section");
			expect(section?.source).toBe("theme");
			expect(JSON.parse(section?.keywords ?? "[]")).toEqual(["hero", "banner"]);
		});

		it("should skip existing sections", async () => {
			// Create section first
			await db
				.insertInto("_emdash_sections")
				.values({
					id: "sec-1",
					slug: "hero-centered",
					title: "Existing Hero",
					description: null,
					keywords: null,
					content: "[]",
					preview_media_id: null,
					source: "theme",
					theme_id: "hero-centered",
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				})
				.execute();

			const seed: SeedFile = {
				version: "1",
				sections: [
					{
						slug: "hero-centered",
						title: "New Hero",
						content: [],
					},
					{
						slug: "cta-newsletter",
						title: "Newsletter CTA",
						content: [],
					},
				],
			};

			const result = await applySeed(db, seed);

			expect(result.sections.created).toBe(1);
			expect(result.sections.skipped).toBe(1);

			// Original title should be preserved
			const section = await db
				.selectFrom("_emdash_sections")
				.selectAll()
				.where("slug", "=", "hero-centered")
				.executeTakeFirst();

			expect(section?.title).toBe("Existing Hero");
		});
	});

	describe("idempotency", () => {
		it("should be safe to run multiple times", async () => {
			const seed: SeedFile = {
				version: "1",
				settings: { siteTitle: "Test Site" },
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
				taxonomies: [
					{
						name: "tags",
						label: "Tags",
						hierarchical: false,
						collections: ["posts"],
						terms: [{ slug: "test", label: "Test" }],
					},
				],
				menus: [
					{
						name: "main",
						label: "Main",
						items: [{ type: "custom", label: "Home", url: "/" }],
					},
				],
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						widgets: [{ type: "content", title: "About" }],
					},
				],
				redirects: [{ source: "/legacy-post", destination: "/posts/test" }],
			};

			// First application
			const result1 = await applySeed(db, seed);
			expect(result1.collections.created).toBe(1);
			expect(result1.taxonomies.created).toBe(1);
			expect(result1.menus.created).toBe(1);
			expect(result1.widgetAreas.created).toBe(1);
			expect(result1.redirects.created).toBe(1);

			// Second application - should skip existing
			const result2 = await applySeed(db, seed);
			expect(result2.collections.created).toBe(0);
			expect(result2.collections.skipped).toBe(1);
			expect(result2.taxonomies.created).toBe(0);
			// Menus and widgets replace items but don't duplicate
			expect(result2.menus.created).toBe(0);
			expect(result2.widgetAreas.created).toBe(0);
			expect(result2.redirects.created).toBe(0);
			expect(result2.redirects.skipped).toBe(1);
		});
	});

	describe("i18n round-trip", () => {
		it("imports menu translations sharing one translation_group", async () => {
			const seed: SeedFile = {
				version: "1",
				menus: [
					{
						id: "menu:primary:en",
						name: "primary",
						label: "Primary",
						locale: "en",
						items: [{ type: "custom", label: "Home", url: "/" }],
					},
					{
						id: "menu:primary:es",
						name: "primary",
						label: "Principal",
						locale: "es",
						translationOf: "menu:primary:en",
						items: [{ type: "custom", label: "Inicio", url: "/" }],
					},
				],
			};

			await applySeed(db, seed);

			const rows = await db
				.selectFrom("_emdash_menus")
				.selectAll()
				.where("name", "=", "primary")
				.orderBy("locale", "asc")
				.execute();

			expect(rows).toHaveLength(2);
			expect(rows[0]?.locale).toBe("en");
			expect(rows[1]?.locale).toBe("es");
			expect(rows[0]?.translation_group).toBe(rows[1]?.translation_group);
			expect(rows[0]?.translation_group).toBe(rows[0]?.id);
		});

		it("imports taxonomy def translations sharing one translation_group", async () => {
			const seed: SeedFile = {
				version: "1",
				taxonomies: [
					{
						id: "tax:topics:en",
						name: "topics",
						label: "Topics",
						hierarchical: false,
						collections: ["posts"],
						locale: "en",
					},
					{
						id: "tax:topics:es",
						name: "topics",
						label: "Temas",
						hierarchical: false,
						collections: ["posts"],
						locale: "es",
						translationOf: "tax:topics:en",
					},
				],
			};

			await applySeed(db, seed);

			const rows = await db
				.selectFrom("_emdash_taxonomy_defs")
				.selectAll()
				.where("name", "=", "topics")
				.orderBy("locale", "asc")
				.execute();

			expect(rows).toHaveLength(2);
			expect(rows[0]?.translation_group).toBe(rows[1]?.translation_group);
		});

		it("imports term translations sharing one translation_group", async () => {
			const seed: SeedFile = {
				version: "1",
				taxonomies: [
					{
						id: "tax:topics:en",
						name: "topics",
						label: "Topics",
						hierarchical: false,
						collections: ["posts"],
						locale: "en",
						terms: [{ id: "term:topics:tech:en", slug: "tech", label: "Tech", locale: "en" }],
					},
					{
						id: "tax:topics:es",
						name: "topics",
						label: "Temas",
						hierarchical: false,
						collections: ["posts"],
						locale: "es",
						translationOf: "tax:topics:en",
						terms: [
							{
								id: "term:topics:tech:es",
								slug: "tecnologia",
								label: "Tecnología",
								locale: "es",
								translationOf: "term:topics:tech:en",
							},
						],
					},
				],
			};

			await applySeed(db, seed);

			const terms = await db
				.selectFrom("taxonomies")
				.selectAll()
				.where("name", "=", "topics")
				.orderBy("locale", "asc")
				.execute();

			expect(terms).toHaveLength(2);
			expect(terms[0]?.slug).toBe("tech");
			expect(terms[1]?.slug).toBe("tecnologia");
			expect(terms[0]?.translation_group).toBe(terms[1]?.translation_group);
		});
	});
});
