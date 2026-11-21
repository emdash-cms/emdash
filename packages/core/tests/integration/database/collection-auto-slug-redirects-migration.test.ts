import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration099 from "../../../src/database/migrations/099_collection_auto_slug_redirects.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("collection auto slug redirects migration (099)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates default-enabled collections before the option column has been migrated", async () => {
		await ctx.db.schema
			.alterTable("_emdash_collections")
			.dropColumn("auto_slug_redirects")
			.execute();
		const registry = new SchemaRegistry(ctx.db);

		await registry.createCollection({ slug: "pending", label: "Pending" });
		await registry.createSeedCollection({ slug: "seeded", label: "Seeded" }, []);

		expect((await registry.getCollection("pending"))?.autoSlugRedirects).toBe(true);
		expect((await registry.getCollection("seeded"))?.autoSlugRedirects).toBe(true);
		await migration099.up(ctx.db);
		expect((await registry.getCollection("pending"))?.autoSlugRedirects).toBe(true);
		expect((await registry.getCollection("seeded"))?.autoSlugRedirects).toBe(true);
	});

	it("defaults existing and new collections to enabled and is rerunnable", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "legacy", label: "Legacy" });
		await ctx.db.schema
			.alterTable("_emdash_collections")
			.dropColumn("auto_slug_redirects")
			.execute();

		await migration099.up(ctx.db);

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
		await migration099.up(ctx.db);

		const preserved = await ctx.db
			.selectFrom("_emdash_collections")
			.select("auto_slug_redirects")
			.where("slug", "=", "legacy")
			.executeTakeFirstOrThrow();
		expect(preserved.auto_slug_redirects).toBe(0);
	});
});
