/**
 * Tests for WXR taxonomy import (categories, tags, custom taxonomies).
 *
 * Regression coverage for issue #1061: the HTTP WXR import handler parsed
 * `wp:category` / `wp:tag` blocks and per-item `<category>` assignments but
 * never wrote anything to `taxonomies` or `content_taxonomies`.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WxrCategory, WxrPost, WxrTag, WxrTerm } from "../../../src/cli/wxr/parser.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import {
	attachPostTaxonomies,
	preImportWxrTaxonomies,
} from "../../../src/import/wxr-taxonomies.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * Build a fully-formed WxrPost with minimal boilerplate.
 */
function makePost(overrides: Partial<WxrPost> = {}): WxrPost {
	return {
		id: 1,
		title: "Test Post",
		postType: "post",
		postName: "test-post",
		status: "publish",
		categories: [],
		tags: [],
		customTaxonomies: new Map(),
		meta: new Map(),
		...overrides,
	};
}

/**
 * Create the `posts` collection (plural) so the seeded `category` / `tag`
 * taxonomy defs (which list `["posts"]` in their `collections` array) match.
 * Inserts a content row and returns its id, ready for taxonomy attachment.
 */
async function createPostsCollectionWithEntry(
	db: Kysely<Database>,
	slug = "hello-world",
): Promise<string> {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "posts", label: "Posts" });
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

	// Insert the content row directly (the runtime handler isn't needed for
	// this test — we just need an existing row to attach taxonomies to).
	const id = `post_${Math.random().toString(36).slice(2, 10)}`;
	await db
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- ec_* tables aren't typed in Database
		.insertInto("ec_posts" as never)
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- dynamic content table shape
		.values({ id, slug, status: "published" } as never)
		.execute();
	return id;
}

describe("preImportWxrTaxonomies", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("creates terms in the seeded `category` taxonomy from <wp:category> blocks", async () => {
		const categories: WxrCategory[] = [
			{ id: 5, nicename: "patents", name: "Patents" },
			{ id: 6, nicename: "research", name: "Research" },
		];

		const plan = await preImportWxrTaxonomies(db, [], categories, [], [], undefined);

		expect(plan.termsCreated.category).toBe(2);
		expect(plan.termsReused.category).toBeUndefined();
		expect(plan.termIdByNameAndSlug.get("category")?.has("patents")).toBe(true);
		expect(plan.termIdByNameAndSlug.get("category")?.has("research")).toBe(true);

		const rows = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", "category")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.slug).toSorted()).toEqual(["patents", "research"]);
		expect(rows.find((r) => r.slug === "patents")?.label).toBe("Patents");
	});

	it("creates terms in the seeded `tag` taxonomy from <wp:tag> blocks", async () => {
		const tags: WxrTag[] = [
			{
				id: 497,
				slug: "electromagnetic-field-distribution-in-liquids",
				name: "Electromagnetic field distribution in liquids",
			},
			{ id: 498, slug: "microwave", name: "Microwave" },
		];

		const plan = await preImportWxrTaxonomies(db, [], [], tags, [], undefined);

		expect(plan.termsCreated.tag).toBe(2);
		expect(plan.termIdByNameAndSlug.get("tag")?.has("microwave")).toBe(true);

		const rows = await db.selectFrom("taxonomies").selectAll().where("name", "=", "tag").execute();
		expect(rows).toHaveLength(2);
	});

	it("re-uses existing terms instead of duplicating them", async () => {
		// Pre-create a term to simulate an existing taxonomy state.
		const repo = new TaxonomyRepository(db);
		await repo.create({ name: "category", slug: "patents", label: "Patents" });

		const plan = await preImportWxrTaxonomies(
			db,
			[],
			[{ id: 5, nicename: "patents", name: "Patents" }],
			[],
			[],
			undefined,
		);

		expect(plan.termsCreated.category).toBeUndefined();
		expect(plan.termsReused.category).toBe(1);

		const rows = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", "category")
			.execute();
		expect(rows).toHaveLength(1);
	});

	it("backfills terms referenced only by per-item <category> assignments", async () => {
		// Hand-edited WXR sometimes omits the top-level <wp:category> blocks
		// but still has per-item <category nicename="…"> assignments.
		const posts: WxrPost[] = [
			makePost({
				id: 1,
				categories: ["only-on-post"],
				tags: ["also-only-here"],
			}),
		];

		const plan = await preImportWxrTaxonomies(db, posts, [], [], [], undefined);

		expect(plan.termsCreated.category).toBe(1);
		expect(plan.termsCreated.tag).toBe(1);
		// Label falls back to slug because the parser doesn't capture the
		// text content of per-item <category> elements.
		const catRow = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("slug", "=", "only-on-post")
			.executeTakeFirst();
		expect(catRow?.label).toBe("only-on-post");
	});

	it("creates terms in custom taxonomies when a matching def exists", async () => {
		// Create a custom 'genre' taxonomy linked to `posts`.
		await db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: "taxdef_genre",
				name: "genre",
				label: "Genres",
				hierarchical: 0,
				collections: JSON.stringify(["posts"]),
			})
			.execute();

		const terms: WxrTerm[] = [
			{ id: 1, taxonomy: "genre", slug: "fiction", name: "Fiction" },
			{ id: 2, taxonomy: "genre", slug: "non-fiction", name: "Non-Fiction" },
		];

		const plan = await preImportWxrTaxonomies(db, [], [], [], terms, undefined);

		expect(plan.termsCreated.genre).toBe(2);
		expect(plan.missingTaxonomies).not.toContain("genre");
	});

	it("records (but does not auto-create) taxonomies that have no EmDash def", async () => {
		const terms: WxrTerm[] = [{ id: 1, taxonomy: "industry", slug: "tech", name: "Technology" }];

		const plan = await preImportWxrTaxonomies(db, [], [], [], terms, undefined);

		expect(plan.termsCreated.industry).toBeUndefined();
		expect(plan.missingTaxonomies).toContain("industry");

		// Nothing was written to `taxonomies` for the missing def.
		const rows = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", "industry")
			.execute();
		expect(rows).toHaveLength(0);
	});

	it("normalises WordPress `post_tag` synonym to EmDash `tag`", async () => {
		// Some exports emit `<wp:term wp:term_taxonomy="post_tag">` instead of
		// `<wp:tag>` — both must land in the same taxonomy.
		const terms: WxrTerm[] = [{ id: 1, taxonomy: "post_tag", slug: "featured", name: "Featured" }];

		const plan = await preImportWxrTaxonomies(db, [], [], [], terms, undefined);

		expect(plan.termsCreated.tag).toBe(1);
		expect(plan.termIdByNameAndSlug.get("tag")?.has("featured")).toBe(true);
	});

	it("records `category` as missing when the seeded def has been deleted", async () => {
		// Simulate a user who removed the default `category` taxonomy via the
		// admin UI before importing.
		await db.deleteFrom("_emdash_taxonomy_defs").where("name", "=", "category").execute();

		const plan = await preImportWxrTaxonomies(
			db,
			[],
			[{ id: 5, nicename: "patents", name: "Patents" }],
			[],
			[],
			undefined,
		);

		expect(plan.missingTaxonomies).toContain("category");
		expect(plan.termsCreated.category).toBeUndefined();
	});

	it("skips nav_menu terms (handled by importMenusFromWxr instead)", async () => {
		const terms: WxrTerm[] = [
			{ id: 1, taxonomy: "nav_menu", slug: "primary", name: "Primary Menu" },
		];

		const plan = await preImportWxrTaxonomies(db, [], [], [], terms, undefined);

		expect(plan.termsCreated).toEqual({});
		// nav_menu shouldn't appear in missingTaxonomies — it's not "missing",
		// it's "not our job here".
		expect(plan.missingTaxonomies).not.toContain("nav_menu");
	});
});

describe("attachPostTaxonomies", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("writes pivot rows for category and tag assignments (regression: issue #1061)", async () => {
		const entryId = await createPostsCollectionWithEntry(db);

		const plan = await preImportWxrTaxonomies(
			db,
			[],
			[{ id: 5, nicename: "patents", name: "Patents" }],
			[{ id: 497, slug: "microwave", name: "Microwave" }],
			[],
			undefined,
		);

		const post = makePost({
			categories: ["patents"],
			tags: ["microwave"],
		});

		const written = await attachPostTaxonomies(db, "posts", entryId, post, plan);

		expect(written).toBe(2);

		const pivotRows = await db
			.selectFrom("content_taxonomies")
			.selectAll()
			.where("collection", "=", "posts")
			.where("entry_id", "=", entryId)
			.execute();
		expect(pivotRows).toHaveLength(2);
	});

	it("respects the taxonomy def's `collections` filter", async () => {
		// Seeded `category` def lists `["posts"]`. Create a different
		// collection and verify category assignments don't leak into it.
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "products", label: "Products" });
		await registry.createField("products", {
			slug: "title",
			label: "Title",
			type: "string",
		});

		const productId = "prod_test1";
		await db
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- ec_* tables aren't typed in Database
			.insertInto("ec_products" as never)
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- dynamic content table shape
			.values({ id: productId, slug: "thing", status: "published" } as never)
			.execute();

		const plan = await preImportWxrTaxonomies(
			db,
			[],
			[{ id: 5, nicename: "patents", name: "Patents" }],
			[],
			[],
			undefined,
		);

		const post = makePost({ categories: ["patents"] });
		const written = await attachPostTaxonomies(db, "products", productId, post, plan);

		expect(written).toBe(0);
		const pivotRows = await db
			.selectFrom("content_taxonomies")
			.selectAll()
			.where("entry_id", "=", productId)
			.execute();
		expect(pivotRows).toHaveLength(0);
	});

	it("is idempotent: re-attaching the same term does not create duplicate rows", async () => {
		const entryId = await createPostsCollectionWithEntry(db);
		const plan = await preImportWxrTaxonomies(
			db,
			[],
			[{ id: 5, nicename: "patents", name: "Patents" }],
			[],
			[],
			undefined,
		);

		const post = makePost({ categories: ["patents"] });
		await attachPostTaxonomies(db, "posts", entryId, post, plan);
		await attachPostTaxonomies(db, "posts", entryId, post, plan);

		const pivotRows = await db
			.selectFrom("content_taxonomies")
			.selectAll()
			.where("entry_id", "=", entryId)
			.execute();
		expect(pivotRows).toHaveLength(1);
	});

	it("silently skips terms with no matching def (custom taxonomies)", async () => {
		const entryId = await createPostsCollectionWithEntry(db);
		const customTax = new Map<string, string[]>();
		customTax.set("industry", ["tech"]);
		const post = makePost({ customTaxonomies: customTax });

		// No def for `industry` — pre-import won't have a term id for it.
		const plan = await preImportWxrTaxonomies(db, [post], [], [], [], undefined);

		const written = await attachPostTaxonomies(db, "posts", entryId, post, plan);
		expect(written).toBe(0);
		expect(plan.missingTaxonomies).toContain("industry");
	});

	it("attaches custom taxonomy terms when a matching def exists", async () => {
		const entryId = await createPostsCollectionWithEntry(db);
		// Create custom 'genre' taxonomy linked to `posts`.
		await db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: "taxdef_genre",
				name: "genre",
				label: "Genres",
				hierarchical: 0,
				collections: JSON.stringify(["posts"]),
			})
			.execute();

		const customTax = new Map<string, string[]>();
		customTax.set("genre", ["fiction"]);
		const post = makePost({ customTaxonomies: customTax });

		const plan = await preImportWxrTaxonomies(
			db,
			[],
			[],
			[],
			[{ id: 1, taxonomy: "genre", slug: "fiction", name: "Fiction" }],
			undefined,
		);

		const written = await attachPostTaxonomies(db, "posts", entryId, post, plan);
		expect(written).toBe(1);

		const rows = await db
			.selectFrom("content_taxonomies")
			.selectAll()
			.where("entry_id", "=", entryId)
			.execute();
		expect(rows).toHaveLength(1);
	});
});
