import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration083 from "../../../src/database/migrations/083_block_types.js";
import {
	createForDialect,
	describeEachDialect,
	runMigrationsForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("block type migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates the block registry tables and can be replayed after completion", async () => {
		await runMigrationsForDialect(ctx);
		await ctx.db.schema.dropTable("_emdash_block_type_versions").execute();
		await expect(migration083.up(ctx.db)).resolves.toBeUndefined();

		const types = await ctx.db.selectFrom("_emdash_block_types").selectAll().execute();
		const versions = await ctx.db.selectFrom("_emdash_block_type_versions").selectAll().execute();
		expect(types).toEqual([]);
		expect(versions).toEqual([]);
	});

	it("enforces slug and version identity", async () => {
		await runMigrationsForDialect(ctx);
		await ctx.db
			.insertInto("_emdash_block_types")
			.values({ id: "type-1", slug: "hero", label: "Hero", current_version: 1, source: "user" })
			.execute();
		await ctx.db
			.insertInto("_emdash_block_type_versions")
			.values({
				id: "version-1",
				block_type_id: "type-1",
				version: 1,
				fields: "[]",
				fingerprint: "one",
			})
			.execute();

		await expect(
			ctx.db
				.insertInto("_emdash_block_types")
				.values({ id: "type-2", slug: "hero", label: "Hero 2", current_version: 1, source: "user" })
				.execute(),
		).rejects.toThrow();
		await expect(
			ctx.db
				.insertInto("_emdash_block_type_versions")
				.values({
					id: "version-2",
					block_type_id: "type-1",
					version: 1,
					fields: "[]",
					fingerprint: "two",
				})
				.execute(),
		).rejects.toThrow();

		await ctx.db.deleteFrom("_emdash_block_types").where("id", "=", "type-1").execute();
		expect(
			await ctx.db
				.selectFrom("_emdash_block_type_versions")
				.select("id")
				.where("block_type_id", "=", "type-1")
				.execute(),
		).toEqual([]);
	});
});
