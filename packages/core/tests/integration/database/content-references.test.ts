import { sql } from "kysely";
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
				slug: "manages",
				parent_collection: "employees",
				child_collection: "employees",
				parent_label: "Manager",
				child_label: "Direct report",
			})
			.execute();

		await ctx.db
			.insertInto("_emdash_content_references")
			.values({
				id: "ref_1",
				relation_id: "rel_manages",
				parent_group: "grp_alice",
				child_group: "grp_bob",
			})
			.execute();

		const rel = await ctx.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where("slug", "=", "manages")
			.executeTakeFirstOrThrow();
		expect(rel.child_collection).toBe("employees");
		expect(rel.parent_label).toBe("Manager");

		const edge = await ctx.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("id", "=", "ref_1")
			.executeTakeFirstOrThrow();
		expect(edge.relation_id).toBe("rel_manages");
		expect(edge.sort_order).toBe(0); // default
	});

	it("rejects a duplicate edge (same relation, parent, child)", async () => {
		await ctx.db
			.insertInto("_emdash_content_references")
			.values({ id: "e1", relation_id: "r1", parent_group: "p1", child_group: "c1" })
			.execute();

		await expect(
			ctx.db
				.insertInto("_emdash_content_references")
				.values({ id: "e2", relation_id: "r1", parent_group: "p1", child_group: "c1" })
				.execute(),
		).rejects.toThrow();
	});

	it("rejects a duplicate relation slug outright", async () => {
		const base = {
			parent_collection: "employees",
			child_collection: "employees",
			parent_label: "Manager",
			child_label: "Report",
		};

		await ctx.db
			.insertInto("_emdash_relations")
			.values({ id: "r_1", slug: "manages", ...base })
			.execute();

		// A slug names exactly one relation — that is what lets a reference
		// selection be addressed by slug from any locale without ambiguity.
		await expect(
			ctx.db
				.insertInto("_emdash_relations")
				.values({ id: "r_2", slug: "manages", ...base, parent_collection: "posts" })
				.execute(),
		).rejects.toThrow();
	});

	it("rejects a relation with a null slug", async () => {
		// A relation with no slug could not be addressed by any surface.
		await expect(
			ctx.db
				.insertInto("_emdash_relations")
				.values({
					id: "n1",
					slug: null as unknown as string,
					parent_collection: "employees",
					child_collection: "employees",
					parent_label: "Manager",
					child_label: "Report",
				})
				.execute(),
		).rejects.toThrow();
	});

	it("forward and backlink traversal return the expected rows", async () => {
		// Parent p1 references children c1, c2 (ordered); p2 also references c1.
		await ctx.db
			.insertInto("_emdash_content_references")
			.values([
				{ id: "e1", relation_id: "r1", parent_group: "p1", child_group: "c1", sort_order: 0 },
				{ id: "e2", relation_id: "r1", parent_group: "p1", child_group: "c2", sort_order: 1 },
				{ id: "e3", relation_id: "r1", parent_group: "p2", child_group: "c1", sort_order: 0 },
			])
			.execute();

		// Forward: p1's children for relation r1, ordered.
		const children = await ctx.db
			.selectFrom("_emdash_content_references")
			.select("child_group")
			.where("parent_group", "=", "p1")
			.where("relation_id", "=", "r1")
			.orderBy("sort_order")
			.execute();
		expect(children.map((r) => r.child_group)).toEqual(["c1", "c2"]);

		// Backlink: who references c1 (any parent) for relation r1.
		const parents = await ctx.db
			.selectFrom("_emdash_content_references")
			.select("parent_group")
			.where("child_group", "=", "c1")
			.where("relation_id", "=", "r1")
			.orderBy("parent_group")
			.execute();
		expect(parents.map((r) => r.parent_group)).toEqual(["p1", "p2"]);
	});

	it("allows same-collection and self references", async () => {
		// Self reference: parent_group === child_group is permitted.
		await ctx.db
			.insertInto("_emdash_content_references")
			.values({ id: "self1", relation_id: "r1", parent_group: "x1", child_group: "x1" })
			.execute();

		const row = await ctx.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("id", "=", "self1")
			.executeTakeFirstOrThrow();
		expect(row.parent_group).toBe(row.child_group);
	});

	it("creates the expected indexes (sqlite)", async () => {
		if (ctx.dialect !== "sqlite") return; // index introspection is dialect-specific

		const result = await sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'index'
		`.execute(ctx.db);
		const names = new Set(result.rows.map((r) => r.name));

		for (const idx of [
			"idx__emdash_relations_parent_collection",
			"idx__emdash_relations_child_collection",
			"idx__emdash_content_references_parent",
			"idx__emdash_content_references_child",
			"idx__emdash_content_references_relation",
		]) {
			expect(names.has(idx), `missing index ${idx}`).toBe(true);
		}

		// 076 dropped the locale-shaped indexes with the columns behind them.
		for (const idx of [
			"idx__emdash_relations_locale",
			"idx__emdash_relations_translation_group",
			"idx__emdash_relations_group_locale_unique",
		]) {
			expect(names.has(idx), `index ${idx} should be gone`).toBe(false);
		}
	});
});
