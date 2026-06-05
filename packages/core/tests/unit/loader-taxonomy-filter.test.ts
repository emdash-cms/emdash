import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

/**
 * Regression test for #1355: taxonomy filtering on collections with a
 * portableText (json) field fails on Postgres because `SELECT DISTINCT *`
 * is invalid when the table contains a native `json` column.
 *
 * The fix restructures the query so DISTINCT only applies to the join key
 * (`ct.entry_id`) inside a subquery, with the outer query selecting `*`.
 */
describeEachDialect("Loader taxonomy filter with JSON field (#1355)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPublishedPost(title: string) {
		const result = await handleContentCreate(ctx.db, "post", {
			data: { title },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	it("returns entries when filtering by taxonomy on a collection with a JSON field", async () => {
		// Seed taxonomy term and link it to a published post
		await ctx.db
			.insertInto("taxonomies")
			.values({
				id: "tax_cat_news",
				name: "category",
				slug: "news",
				label: "News",
			})
			.execute();

		const post = await createPublishedPost("News Post");

		await ctx.db
			.insertInto("content_taxonomies")
			.values({
				collection: "post",
				entry_id: post.id,
				taxonomy_id: "tax_cat_news",
			})
			.execute();

		// Also create an unrelated post to verify filtering works
		await createPublishedPost("Other Post");

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { category: "news" } },
			}),
		);

		expect(result.error).toBeUndefined();
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("News Post");
	});

	it("combines taxonomy filter with a field filter on a JSON-field collection", async () => {
		await ctx.db
			.insertInto("taxonomies")
			.values({
				id: "tax_cat_tech",
				name: "category",
				slug: "tech",
				label: "Tech",
			})
			.execute();

		const postA = await createPublishedPost("Tech Post A");
		const postB = await createPublishedPost("Tech Post B");
		await createPublishedPost("Untagged Post");

		await ctx.db
			.insertInto("content_taxonomies")
			.values([
				{ collection: "post", entry_id: postA.id, taxonomy_id: "tax_cat_tech" },
				{ collection: "post", entry_id: postB.id, taxonomy_id: "tax_cat_tech" },
			])
			.execute();

		// Add a field we can filter on
		const { SchemaRegistry } = await import("../../src/schema/registry.js");
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "series", label: "Series", type: "string" });

		// Update posts to have different series values
		await ctx.db
			.updateTable("ec_post")
			.set({ series: "alpha" })
			.where("id", "=", postA.id)
			.execute();
		await ctx.db
			.updateTable("ec_post")
			.set({ series: "beta" })
			.where("id", "=", postB.id)
			.execute();

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { category: "tech", series: "alpha" } },
			}),
		);

		expect(result.error).toBeUndefined();
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("Tech Post A");
	});
});
