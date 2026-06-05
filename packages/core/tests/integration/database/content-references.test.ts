import { afterEach, beforeEach, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("Content references schema", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect); // runs all migrations
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates _emdash_relations and _emdash_content_references", async () => {
		for (const table of ["_emdash_relations", "_emdash_content_references"] as const) {
			const rows = await ctx.db
				.selectFrom(table as keyof Database)
				.selectAll()
				.execute();
			expect(Array.isArray(rows), `table ${table} should exist`).toBe(true);
		}
	});

	it("accepts a relation row and an edge row with the expected columns", async () => {
		await ctx.db
			.insertInto("_emdash_relations")
			.values({
				id: "rel_manages",
				name: "manages",
				parent_collection: "employees",
				child_collection: "employees",
				parent_label: "Manager",
				child_label: "Direct report",
				translation_group: "rel_manages",
			})
			.execute();

		await ctx.db
			.insertInto("_emdash_content_references")
			.values({
				id: "ref_1",
				relation_group: "rel_manages",
				parent_group: "grp_alice",
				child_group: "grp_bob",
			})
			.execute();

		const rel = await ctx.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where("name", "=", "manages")
			.executeTakeFirstOrThrow();
		expect(rel.locale).toBe("en"); // default locale backfill
		expect(rel.child_collection).toBe("employees");

		const edge = await ctx.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("id", "=", "ref_1")
			.executeTakeFirstOrThrow();
		expect(edge.relation_group).toBe("rel_manages");
		expect(edge.sort_order).toBe(0); // default
	});
});
