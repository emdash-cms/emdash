import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration089 from "../../../src/database/migrations/089_auto_seed_completion.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("auto-seed completion migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("087_reference_field_relations");
		if (error) throw error;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("marks an existing configured site complete and can restart", async () => {
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "posts", slug: "posts", label: "Posts" })
			.execute();

		await migration089.up(ctx.db);
		await expect(migration089.up(ctx.db)).resolves.toBeUndefined();

		await expect(
			ctx.db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:seed_complete")
				.executeTakeFirst(),
		).resolves.toEqual({ value: "true" });
	});

	it("leaves a new empty site eligible for runtime auto-seeding", async () => {
		await migration089.up(ctx.db);

		await expect(
			ctx.db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:seed_complete")
				.executeTakeFirst(),
		).resolves.toBeUndefined();
	});
});
