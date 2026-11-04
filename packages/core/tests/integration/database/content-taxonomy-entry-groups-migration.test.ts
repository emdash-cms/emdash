import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration068 from "../../../src/database/migrations/068_content_taxonomy_entry_groups.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content taxonomy entry-group migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("preserves assignments and collapses sibling-locale duplicates", async () => {
		const content = new ContentRepository(ctx.db);
		const taxonomies = new TaxonomyRepository(ctx.db);
		const enPost = await content.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			locale: "en",
		});
		const frPost = await content.create({
			type: "post",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: enPost.id,
		});
		const news = await taxonomies.create({ name: "tags", slug: "news", label: "News" });
		const sports = await taxonomies.create({ name: "tags", slug: "sports", label: "Sports" });

		await ctx.db
			.insertInto("content_taxonomies")
			.values([
				{
					collection: "post",
					entry_id: frPost.id,
					taxonomy_id: news.translationGroup ?? news.id,
				},
				{
					collection: "post",
					entry_id: enPost.id,
					taxonomy_id: sports.translationGroup ?? sports.id,
				},
				{
					collection: "post",
					entry_id: frPost.id,
					taxonomy_id: sports.translationGroup ?? sports.id,
				},
			])
			.execute();

		await migration068.up(ctx.db);

		const rows = await ctx.db
			.selectFrom("content_taxonomies")
			.select(["entry_id", "taxonomy_id"])
			.where("collection", "=", "post")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows).toEqual(
			expect.arrayContaining([
				{ entry_id: enPost.translationGroup, taxonomy_id: news.translationGroup },
				{ entry_id: enPost.translationGroup, taxonomy_id: sports.translationGroup },
			]),
		);
	});
});
