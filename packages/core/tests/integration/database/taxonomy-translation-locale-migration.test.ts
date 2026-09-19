import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration082 from "../../../src/database/migrations/082_taxonomy_translation_locale_unique.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	runMigrationsForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("taxonomy translation locale uniqueness migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("081_redirect_write_guards");
		if (error) throw error;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("splits duplicate locale rows without losing their existing assignments and can restart", async () => {
		await ctx.db
			.insertInto("taxonomies")
			.values([
				{
					id: "term-a",
					name: "category",
					slug: "news",
					label: "News",
					parent_id: null,
					data: null,
					sort_order: 0,
					locale: "en",
					translation_group: "term-a",
				},
				{
					id: "term-b",
					name: "category",
					slug: "updates",
					label: "Updates",
					parent_id: null,
					data: null,
					sort_order: 1,
					locale: "en",
					translation_group: "term-a",
				},
			])
			.execute();
		await ctx.db
			.insertInto("content_taxonomies")
			.values({ collection: "posts", entry_id: "post-group", taxonomy_id: "term-a" })
			.execute();

		const { applied } = await runMigrationsForDialect(ctx);
		expect(applied).toEqual(["082_taxonomy_translation_locale_unique"]);
		await expect(migration082.up(ctx.db)).resolves.toBeUndefined();

		const terms = await ctx.db
			.selectFrom("taxonomies")
			.select(["id", "translation_group"])
			.orderBy("id", "asc")
			.execute();
		expect(terms).toEqual([
			{ id: "term-a", translation_group: "term-a" },
			{ id: "term-b", translation_group: "term-b" },
		]);
		const assignments = await ctx.db
			.selectFrom("content_taxonomies")
			.select("taxonomy_id")
			.where("collection", "=", "posts")
			.where("entry_id", "=", "post-group")
			.orderBy("taxonomy_id", "asc")
			.execute();
		expect(assignments).toEqual([{ taxonomy_id: "term-a" }, { taxonomy_id: "term-b" }]);
	});
});
