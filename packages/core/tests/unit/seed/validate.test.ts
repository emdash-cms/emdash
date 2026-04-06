import { describe, it, expect } from "vitest";

import type { SeedFile } from "../../../src/seed/types.js";
import { validateSeed } from "../../../src/seed/validate.js";

describe("validateSeed", () => {
	describe("basic validation", () => {
		it("should reject non-object input", () => {
			expect(validateSeed(null)).toMatchObject({
				valid: false,
				errors: ["Seed must be an object"],
			});

			expect(validateSeed("string")).toMatchObject({
				valid: false,
				errors: ["Seed must be an object"],
			});
		});

		it("should require version field", () => {
			const result = validateSeed({});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Seed must have a version field");
		});

		it("should reject unsupported versions", () => {
			const result = validateSeed({ version: "2" });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Unsupported seed version: 2");
		});

		it("should accept valid minimal seed", () => {
			const result = validateSeed({ version: "1" });
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe("collection validation", () => {
		it("should require collections to be an array", () => {
			const result = validateSeed({
				version: "1",
				collections: "not an array",
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("collections must be an array");
		});

		it("should require collection slug", () => {
			const result = validateSeed({
				version: "1",
				collections: [{ label: "Posts", fields: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("collections[0]: slug is required");
		});

		it("should require collection label", () => {
			const result = validateSeed({
				version: "1",
				collections: [{ slug: "posts", fields: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("collections[0]: label is required");
		});

		it("should validate slug format", () => {
			const result = validateSeed({
				version: "1",
				collections: [{ slug: "My Posts", label: "Posts", fields: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("must start with a letter");
		});

		it("should reject duplicate collection slugs", () => {
			const result = validateSeed({
				version: "1",
				collections: [
					{ slug: "posts", label: "Posts", fields: [] },
					{ slug: "posts", label: "Posts Again", fields: [] },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('collections[1].slug: duplicate collection slug "posts"');
		});

		it("should require fields to be an array", () => {
			const result = validateSeed({
				version: "1",
				collections: [{ slug: "posts", label: "Posts", fields: "not array" }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("collections[0].fields: must be an array");
		});

		it("should reject urlPattern without {slug} placeholder", () => {
			const result = validateSeed({
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						urlPattern: "/blog/broken",
						fields: [],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"collections[0].urlPattern: must include a {slug} placeholder",
			);
		});

		it("should accept urlPattern with {slug} placeholder", () => {
			const result = validateSeed({
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						urlPattern: "/blog/{slug}",
						fields: [],
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it("should validate field properties", () => {
			const result = validateSeed({
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title" }], // missing label and type
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("collections[0].fields[0]: label is required");
			expect(result.errors).toContain("collections[0].fields[0]: type is required");
		});

		it("should reject invalid field types", () => {
			const result = validateSeed({
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "invalid" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('unsupported field type "invalid"');
		});

		it("should reject duplicate field slugs", () => {
			const result = validateSeed({
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [
							{ slug: "title", label: "Title", type: "string" },
							{ slug: "title", label: "Title 2", type: "string" },
						],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('duplicate field slug "title"');
		});

		it("should accept valid collection with fields", () => {
			const result = validateSeed({
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [
							{ slug: "title", label: "Title", type: "string", required: true },
							{ slug: "content", label: "Content", type: "portableText" },
						],
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe("taxonomy validation", () => {
		it("should require taxonomy name", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [{ label: "Categories", hierarchical: true, collections: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("taxonomies[0]: name is required");
		});

		it("should require taxonomy label", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [{ name: "category", hierarchical: true, collections: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("taxonomies[0]: label is required");
		});

		it("should require hierarchical field", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [{ name: "category", label: "Categories", collections: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("taxonomies[0]: hierarchical is required");
		});

		it("should warn about taxonomy with no collections", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [
					{
						name: "category",
						label: "Categories",
						hierarchical: true,
						collections: [],
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain(
				'taxonomies[0].collections: taxonomy "category" is not assigned to any collections',
			);
		});

		it("should reject duplicate taxonomy names", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [
					{
						name: "category",
						label: "Categories",
						hierarchical: true,
						collections: ["posts"],
					},
					{
						name: "category",
						label: "Categories 2",
						hierarchical: true,
						collections: ["posts"],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('taxonomies[1].name: duplicate taxonomy name "category"');
		});

		it("should validate term properties", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [
					{
						name: "category",
						label: "Categories",
						hierarchical: true,
						collections: ["posts"],
						terms: [{ slug: "news" }], // missing label
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("taxonomies[0].terms[0]: label is required");
		});

		it("should reject duplicate term slugs", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [
					{
						name: "category",
						label: "Categories",
						hierarchical: true,
						collections: ["posts"],
						terms: [
							{ slug: "news", label: "News" },
							{ slug: "news", label: "News 2" },
						],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('duplicate term slug "news"');
		});

		it("should reject self-referencing parent", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [
					{
						name: "category",
						label: "Categories",
						hierarchical: true,
						collections: ["posts"],
						terms: [{ slug: "news", label: "News", parent: "news" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"taxonomies[0].terms[0].parent: term cannot be its own parent",
			);
		});

		it("should reject invalid parent reference", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [
					{
						name: "category",
						label: "Categories",
						hierarchical: true,
						collections: ["posts"],
						terms: [{ slug: "news", label: "News", parent: "nonexistent" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				'taxonomies[0].terms[0].parent: parent term "nonexistent" not found in taxonomy',
			);
		});

		it("should warn about parent on non-hierarchical taxonomy", () => {
			const result = validateSeed({
				version: "1",
				taxonomies: [
					{
						name: "tag",
						label: "Tags",
						hierarchical: false,
						collections: ["posts"],
						terms: [{ slug: "news", label: "News", parent: "other" }],
					},
				],
			});
			expect(result.valid).toBe(true);
			expect(result.warnings[0]).toContain("is not hierarchical, parent will be ignored");
		});
	});

	describe("menu validation", () => {
		it("should require menu name and label", () => {
			const result = validateSeed({
				version: "1",
				menus: [{ items: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("menus[0]: name is required");
			expect(result.errors).toContain("menus[0]: label is required");
		});

		it("should reject duplicate menu names", () => {
			const result = validateSeed({
				version: "1",
				menus: [
					{ name: "primary", label: "Primary", items: [] },
					{ name: "primary", label: "Primary 2", items: [] },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('menus[1].name: duplicate menu name "primary"');
		});

		it("should validate menu item types", () => {
			const result = validateSeed({
				version: "1",
				menus: [
					{
						name: "primary",
						label: "Primary",
						items: [{ type: "invalid" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('must be "custom", "page", "post"');
		});

		it("should require url for custom items", () => {
			const result = validateSeed({
				version: "1",
				menus: [
					{
						name: "primary",
						label: "Primary",
						items: [{ type: "custom", label: "Link" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("menus[0].items[0]: url is required for custom menu items");
		});

		it("should require ref for page/post items", () => {
			const result = validateSeed({
				version: "1",
				menus: [
					{
						name: "primary",
						label: "Primary",
						items: [{ type: "page", label: "About" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"menus[0].items[0]: ref is required for page/post menu items",
			);
		});

		it("should validate nested menu items", () => {
			const result = validateSeed({
				version: "1",
				menus: [
					{
						name: "primary",
						label: "Primary",
						items: [
							{
								type: "custom",
								url: "/about",
								label: "About",
								children: [{ type: "page" }], // missing ref
							},
						],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"menus[0].items[0].items[0]: ref is required for page/post menu items",
			);
		});

		it("should warn about menu refs not in content", () => {
			const result = validateSeed({
				version: "1",
				menus: [
					{
						name: "primary",
						label: "Primary",
						items: [{ type: "page", ref: "about" }],
					},
				],
				content: {
					pages: [{ id: "home", slug: "home", data: { title: "Home" } }],
				},
			});
			expect(result.valid).toBe(true);
			expect(result.warnings).toContain(
				'Menu item references content "about" which is not in the seed file',
			);
		});
	});

	describe("widget area validation", () => {
		it("should require widget area name and label", () => {
			const result = validateSeed({
				version: "1",
				widgetAreas: [{ widgets: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("widgetAreas[0]: name is required");
			expect(result.errors).toContain("widgetAreas[0]: label is required");
		});

		it("should reject duplicate widget area names", () => {
			const result = validateSeed({
				version: "1",
				widgetAreas: [
					{ name: "sidebar", label: "Sidebar", widgets: [] },
					{ name: "sidebar", label: "Sidebar 2", widgets: [] },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('widgetAreas[1].name: duplicate widget area name "sidebar"');
		});

		it("should validate widget types", () => {
			const result = validateSeed({
				version: "1",
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						widgets: [{ type: "invalid" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('must be "content", "menu", or "component"');
		});

		it("should require menuName for menu widgets", () => {
			const result = validateSeed({
				version: "1",
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						widgets: [{ type: "menu", title: "Nav" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"widgetAreas[0].widgets[0]: menuName is required for menu widgets",
			);
		});

		it("should require componentId for component widgets", () => {
			const result = validateSeed({
				version: "1",
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						widgets: [{ type: "component", title: "Recent Posts" }],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"widgetAreas[0].widgets[0]: componentId is required for component widgets",
			);
		});
	});

	describe("redirect validation", () => {
		it("should require redirects to be an array", () => {
			const result = validateSeed({
				version: "1",
				redirects: "not an array",
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("redirects must be an array");
		});

		it("should require source and destination", () => {
			const result = validateSeed({
				version: "1",
				redirects: [{}],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("redirects[0]: source is required");
			expect(result.errors).toContain("redirects[0]: destination is required");
		});

		it("should validate redirect source and destination paths", () => {
			const result = validateSeed({
				version: "1",
				redirects: [{ source: "https://example.com", destination: "//external" }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"redirects[0].source: must be a path starting with / (no protocol-relative URLs, path traversal, or newlines)",
			);
			expect(result.errors).toContain(
				"redirects[0].destination: must be a path starting with / (no protocol-relative URLs, path traversal, or newlines)",
			);
		});

		it("should validate redirect type", () => {
			const result = validateSeed({
				version: "1",
				redirects: [{ source: "/old", destination: "/new", type: 303 }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("redirects[0].type: must be 301, 302, 307, or 308");
		});

		it("should reject duplicate redirect sources", () => {
			const result = validateSeed({
				version: "1",
				redirects: [
					{ source: "/old", destination: "/new" },
					{ source: "/old", destination: "/newer" },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('redirects[1].source: duplicate redirect source "/old"');
		});

		it("should accept valid redirects", () => {
			const result = validateSeed({
				version: "1",
				redirects: [
					{ source: "/old", destination: "/new" },
					{ source: "/temp", destination: "/next", type: 302, enabled: false },
				],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe("content validation", () => {
		it("should require content to be an object", () => {
			const result = validateSeed({
				version: "1",
				content: [],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("content must be an object (collection -> entries)");
		});

		it("should require content entries to be arrays", () => {
			const result = validateSeed({
				version: "1",
				content: { posts: "not array" },
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("content.posts: must be an array");
		});

		it("should require entry id and slug", () => {
			const result = validateSeed({
				version: "1",
				content: {
					posts: [{ data: { title: "Hello" } }],
				},
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("content.posts[0]: id is required");
			expect(result.errors).toContain("content.posts[0]: slug is required");
		});

		it("should require entry data to be an object", () => {
			const result = validateSeed({
				version: "1",
				content: {
					posts: [{ id: "hello", slug: "hello", data: "not object" }],
				},
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("content.posts[0]: data must be an object");
		});

		it("should reject duplicate entry ids", () => {
			const result = validateSeed({
				version: "1",
				content: {
					posts: [
						{ id: "hello", slug: "hello", data: { title: "Hello" } },
						{ id: "hello", slug: "hello-2", data: { title: "Hello 2" } },
					],
				},
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				'content.posts[1].id: duplicate entry id "hello" in collection "posts"',
			);
		});

		it("should validate byline references in content entries", () => {
			const result = validateSeed({
				version: "1",
				bylines: [{ id: "editorial", slug: "editorial", displayName: "Editorial" }],
				content: {
					posts: [
						{
							id: "post-1",
							slug: "hello",
							data: { title: "Hello" },
							bylines: [{ byline: "missing" }],
						},
					],
				},
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				'content.posts[0].bylines[0].byline: references unknown byline "missing"',
			);
		});
	});

	describe("byline validation", () => {
		it("should require byline id, slug, and displayName", () => {
			const result = validateSeed({
				version: "1",
				bylines: [{ slug: "editorial" }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("bylines[0]: id is required");
			expect(result.errors).toContain("bylines[0]: displayName is required");
		});

		it("should reject duplicate byline ids and slugs", () => {
			const result = validateSeed({
				version: "1",
				bylines: [
					{ id: "editorial", slug: "editorial", displayName: "Editorial" },
					{ id: "editorial", slug: "editorial", displayName: "Editorial 2" },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('bylines[1].id: duplicate byline id "editorial"');
			expect(result.errors).toContain('bylines[1].slug: duplicate byline slug "editorial"');
		});
	});

	describe("full seed validation", () => {
		it("should accept a complete valid seed", () => {
			const seed: SeedFile = {
				version: "1",
				meta: {
					name: "Blog Starter",
					description: "A simple blog template",
				},
				settings: {
					title: "My Blog",
					tagline: "Thoughts and ideas",
				},
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [
							{ slug: "title", label: "Title", type: "string", required: true },
							{ slug: "content", label: "Content", type: "portableText" },
						],
					},
					{
						slug: "pages",
						label: "Pages",
						fields: [
							{ slug: "title", label: "Title", type: "string", required: true },
							{ slug: "content", label: "Content", type: "portableText" },
						],
					},
				],
				taxonomies: [
					{
						name: "category",
						label: "Categories",
						hierarchical: true,
						collections: ["posts"],
						terms: [
							{ slug: "news", label: "News" },
							{ slug: "tutorials", label: "Tutorials" },
						],
					},
				],
				menus: [
					{
						name: "primary",
						label: "Primary Navigation",
						items: [
							{ type: "custom", url: "/", label: "Home" },
							{ type: "page", ref: "about" },
						],
					},
				],
				redirects: [
					{ source: "/old-about", destination: "/about" },
					{ source: "/legacy-feed", destination: "/rss.xml", type: 308, groupName: "import" },
				],
				widgetAreas: [
					{
						name: "sidebar",
						label: "Sidebar",
						widgets: [
							{
								type: "component",
								componentId: "core:recent-posts",
								props: { count: 5 },
							},
						],
					},
				],
				content: {
					pages: [
						{
							id: "about",
							slug: "about",
							status: "published",
							data: { title: "About", content: [] },
						},
					],
					posts: [
						{
							id: "hello",
							slug: "hello-world",
							status: "published",
							data: { title: "Hello World", content: [] },
							taxonomies: { category: ["news"] },
						},
					],
				},
			};

			const result = validateSeed(seed);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});
});
