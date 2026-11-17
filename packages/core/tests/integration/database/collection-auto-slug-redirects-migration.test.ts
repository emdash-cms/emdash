import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration096 from "../../../src/database/migrations/096_collection_auto_slug_redirects.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("collection auto slug redirects migration (096)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("defaults existing and new collections to enabled and is rerunnable", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "legacy", label: "Legacy" });
		await ctx.db.schema
			.alterTable("_emdash_collections")
			.dropColumn("auto_slug_redirects")
			.execute();

		await migration096.up(ctx.db);

		const legacy = await ctx.db
			.selectFrom("_emdash_collections")
			.select("auto_slug_redirects")
			.where("slug", "=", "legacy")
			.executeTakeFirstOrThrow();
		expect(legacy.auto_slug_redirects).toBe(1);

		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "new", slug: "new", label: "New" })
			.execute();
		const created = await ctx.db
			.selectFrom("_emdash_collections")
			.select("auto_slug_redirects")
			.where("slug", "=", "new")
			.executeTakeFirstOrThrow();
		expect(created.auto_slug_redirects).toBe(1);

		await ctx.db
			.updateTable("_emdash_collections")
			.set({ auto_slug_redirects: 0 })
			.where("slug", "=", "legacy")
			.execute();
		await migration096.up(ctx.db);

		const preserved = await ctx.db
			.selectFrom("_emdash_collections")
			.select("auto_slug_redirects")
			.where("slug", "=", "legacy")
			.executeTakeFirstOrThrow();
		expect(preserved.auto_slug_redirects).toBe(0);
	});
});
