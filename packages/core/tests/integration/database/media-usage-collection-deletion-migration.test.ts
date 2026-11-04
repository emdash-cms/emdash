import { afterEach, beforeEach, expect, it } from "vitest";

import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage collection deletion migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("keeps a unique exact-ID tombstone and slug lock", async () => {
		const migration = await ctx.db
			.selectFrom("_emdash_migrations")
			.select("name")
			.where("name", "=", "065_media_usage_collection_deletion")
			.executeTakeFirst();
		expect(migration).toBeDefined();

		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: "collection-1",
				collection_slug: "articles",
				force_delete: 0,
				state: "pending",
				phase: "fence",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(
			ctx.db
				.insertInto("_emdash_media_usage_collection_deletions")
				.values({
					collection_id: "collection-2",
					collection_slug: "articles",
					force_delete: 1,
					state: "pending",
					phase: "fence",
					next_attempt_at: "2000-01-01T00:00:00.000Z",
				})
				.execute(),
		).rejects.toThrow();
	});

	it("refuses rollback while durable deletion evidence exists", async () => {
		const migration =
			await import("../../../src/database/migrations/065_media_usage_collection_deletion.js");
		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: "collection-1",
				collection_slug: "articles",
				force_delete: 0,
				state: "pending",
				phase: "fence",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(migration.down(ctx.db)).rejects.toThrow(/durable collection deletion/i);
	});
});
