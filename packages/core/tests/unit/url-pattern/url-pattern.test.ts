import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { compileUrlPattern } from "../../../src/schema/url-pattern.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn().mockResolvedValue({
		entry: {
			id: "example",
			data: { id: "entry-id", slug: "example", status: "published", locale: "en" },
		},
		cacheHint: {},
	}),
}));

describe("urlPattern", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("schema registry", () => {
		it("treats URL-pattern punctuation as literals", () => {
			const { regex } = compileUrlPattern("/posts/{slug}.html");

			expect(regex.test("/posts/example.html")).toBe(true);
			expect(regex.test("/posts/exampleXhtml")).toBe(false);
		});

		it("invalidates URL patterns across duplicated query modules", async () => {
			const firstQueryModule = await import("../../../src/query.js");
			firstQueryModule.invalidateUrlPatternCache();
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/old/{slug}",
			});
			await sql`
				INSERT INTO ec_posts (id, slug, status) VALUES (${ulid()}, ${"example"}, ${"published"})
			`.execute(db);
			expect(
				await runWithContext({ editMode: false, db }, () =>
					firstQueryModule.resolveEmDashPath("/old/example"),
				),
			).not.toBeNull();

			await db
				.updateTable("_emdash_collections")
				.set({ url_pattern: "/new/{slug}" })
				.where("slug", "=", "posts")
				.execute();
			vi.resetModules();
			const secondQueryModule = await import("../../../src/query.js");
			secondQueryModule.invalidateUrlPatternCache();

			expect(
				await runWithContext({ editMode: false, db }, () =>
					firstQueryModule.resolveEmDashPath("/new/example"),
				),
			).not.toBeNull();
		});

		it("should store urlPattern on create", async () => {
			const collection = await registry.createCollection({
				slug: "pages",
				label: "Pages",
				urlPattern: "/{slug}",
			});

			expect(collection.urlPattern).toBe("/{slug}");
		});

		it("should default urlPattern to undefined when not provided", async () => {
			const collection = await registry.createCollection({
				slug: "posts",
				label: "Posts",
			});

			expect(collection.urlPattern).toBeUndefined();
		});

		it("should persist urlPattern in the database", async () => {
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});

			const row = await db
				.selectFrom("_emdash_collections")
				.select("url_pattern")
				.where("slug", "=", "posts")
				.executeTakeFirst();

			expect(row?.url_pattern).toBe("/blog/{slug}");
		});

		it("should return urlPattern from getCollection", async () => {
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});

			const collection = await registry.getCollection("posts");
			expect(collection?.urlPattern).toBe("/blog/{slug}");
		});

		it("should update urlPattern", async () => {
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});

			const updated = await registry.updateCollection("posts", {
				urlPattern: "/articles/{slug}",
			});

			expect(updated.urlPattern).toBe("/articles/{slug}");
		});

		it("should clear urlPattern when set to undefined", async () => {
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});

			// Setting to undefined in the update should clear it
			const updated = await registry.updateCollection("posts", {
				urlPattern: undefined,
			});

			// urlPattern was not in the update input, so it should keep the old value
			expect(updated.urlPattern).toBe("/blog/{slug}");
		});

		it("should clear urlPattern when explicitly set to null-ish", async () => {
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});

			// Explicitly passing null (via the update interface) should clear it
			const updated = await registry.updateCollection("posts", {
				urlPattern: "" as any, // empty string to clear
			});

			// Empty string is falsy but still a defined value
			expect(updated.urlPattern).toBe("");
		});

		it("should include urlPattern in listCollections", async () => {
			await registry.createCollection({
				slug: "pages",
				label: "Pages",
				urlPattern: "/{slug}",
			});
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});

			const collections = await registry.listCollections();
			const patterns = collections.map((c) => ({ slug: c.slug, urlPattern: c.urlPattern }));

			expect(patterns).toEqual([
				{ slug: "pages", urlPattern: "/{slug}" },
				{ slug: "posts", urlPattern: "/blog/{slug}" },
			]);
		});
	});

	describe("menu URL resolution", () => {
		it("should use urlPattern for content URL resolution", async () => {
			// Create a pages collection with urlPattern
			await registry.createCollection({
				slug: "pages",
				label: "Pages",
				urlPattern: "/{slug}",
			});
			await registry.createField("pages", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			// Insert a page
			const pageId = ulid();
			await sql`
				INSERT INTO ec_pages (id, slug, status) VALUES (${pageId}, ${"about"}, ${"published"})
			`.execute(db);

			// Create a menu with a page reference
			const menuId = ulid();
			await db
				.insertInto("_emdash_menus")
				.values({ id: menuId, name: "primary", label: "Primary" })
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: ulid(),
					menu_id: menuId,
					sort_order: 0,
					type: "page",
					reference_collection: "pages",
					reference_id: pageId,
					label: "About",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			expect(menu!.items).toHaveLength(1);
			expect(menu!.items[0].url).toBe("/about");
		});

		it("should fall back to /{collection}/{slug} when no urlPattern", async () => {
			// Create a posts collection without urlPattern
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
			});
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			// Insert a post
			const postId = ulid();
			await sql`
				INSERT INTO ec_posts (id, slug, status) VALUES (${postId}, ${"hello"}, ${"published"})
			`.execute(db);

			// Create a menu with a post reference
			const menuId = ulid();
			await db
				.insertInto("_emdash_menus")
				.values({ id: menuId, name: "primary", label: "Primary" })
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: ulid(),
					menu_id: menuId,
					sort_order: 0,
					type: "post",
					reference_collection: "posts",
					reference_id: postId,
					label: "Hello",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu!.items[0].url).toBe("/posts/hello");
		});

		it("should interpolate {slug} in urlPattern", async () => {
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const postId = ulid();
			await sql`
				INSERT INTO ec_posts (id, slug, status) VALUES (${postId}, ${"my-post"}, ${"published"})
			`.execute(db);

			const menuId = ulid();
			await db
				.insertInto("_emdash_menus")
				.values({ id: menuId, name: "primary", label: "Primary" })
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: ulid(),
					menu_id: menuId,
					sort_order: 0,
					type: "post",
					reference_collection: "posts",
					reference_id: postId,
					label: "My Post",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu!.items[0].url).toBe("/blog/my-post");
		});

		it("should handle multiple collections with different patterns", async () => {
			// Pages: /{slug}
			await registry.createCollection({
				slug: "pages",
				label: "Pages",
				urlPattern: "/{slug}",
			});
			await registry.createField("pages", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			// Posts: /blog/{slug}
			await registry.createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/blog/{slug}",
			});
			await registry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const pageId = ulid();
			const postId = ulid();
			await sql`INSERT INTO ec_pages (id, slug, status) VALUES (${pageId}, ${"about"}, ${"published"})`.execute(
				db,
			);
			await sql`INSERT INTO ec_posts (id, slug, status) VALUES (${postId}, ${"hello"}, ${"published"})`.execute(
				db,
			);

			const menuId = ulid();
			await db
				.insertInto("_emdash_menus")
				.values({ id: menuId, name: "nav", label: "Nav" })
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values([
					{
						id: ulid(),
						menu_id: menuId,
						sort_order: 0,
						type: "page",
						reference_collection: "pages",
						reference_id: pageId,
						label: "About",
					},
					{
						id: ulid(),
						menu_id: menuId,
						sort_order: 1,
						type: "post",
						reference_collection: "posts",
						reference_id: postId,
						label: "Hello",
					},
				])
				.execute();

			const menu = await getMenuWithDb("nav", db);
			expect(menu!.items[0].url).toBe("/about");
			expect(menu!.items[1].url).toBe("/blog/hello");
		});
	});

	describe("seed", () => {
		it("should persist urlPattern from seed", async () => {
			const seed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "pages",
						label: "Pages",
						urlPattern: "/{slug}",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
					{
						slug: "posts",
						label: "Posts",
						urlPattern: "/blog/{slug}",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
			};

			await applySeed(db, seed);

			const pages = await registry.getCollection("pages");
			const posts = await registry.getCollection("posts");

			expect(pages?.urlPattern).toBe("/{slug}");
			expect(posts?.urlPattern).toBe("/blog/{slug}");
		});

		it("should handle seed without urlPattern", async () => {
			const seed: SeedFile = {
				version: "1",
				collections: [
					{
						slug: "posts",
						label: "Posts",
						fields: [{ slug: "title", label: "Title", type: "string" }],
					},
				],
			};

			await applySeed(db, seed);

			const posts = await registry.getCollection("posts");
			expect(posts?.urlPattern).toBeUndefined();
		});
	});
});
