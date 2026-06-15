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

	it("rejects a duplicate edge (same relation, parent, child)", async () => {
		await ctx.db
			.insertInto("_emdash_content_references")
			.values({ id: "e1", relation_group: "r1", parent_group: "p1", child_group: "c1" })
			.execute();

		await expect(
			ctx.db
				.insertInto("_emdash_content_references")
				.values({ id: "e2", relation_group: "r1", parent_group: "p1", child_group: "c1" })
				.execute(),
		).rejects.toThrow();
	});

	it("rejects a duplicate relation name within one locale, allows across locales", async () => {
		const base = {
			name: "manages",
			parent_collection: "employees",
			child_collection: "employees",
			parent_label: "Manager",
			child_label: "Report",
			translation_group: "tg1",
		};

		await ctx.db
			.insertInto("_emdash_relations")
			.values({ id: "r_en", locale: "en", ...base })
			.execute();

		// Same (name, locale) -> rejected
		await expect(
			ctx.db
				.insertInto("_emdash_relations")
				.values({ id: "r_en2", locale: "en", ...base })
				.execute(),
		).rejects.toThrow();

		// Same name, different locale -> allowed
		await ctx.db
			.insertInto("_emdash_relations")
			.values({
				id: "r_fr",
				locale: "fr",
				...base,
				parent_label: "Responsable",
				child_label: "Subordonné",
			})
			.execute();

		const rows = await ctx.db
			.selectFrom("_emdash_relations")
			.select(["id", "locale"])
			.where("name", "=", "manages")
			.execute();
		expect(rows).toHaveLength(2);
	});

	it("rejects a duplicate (translation_group, locale), allows across locales", async () => {
		const base = {
			parent_collection: "employees",
			child_collection: "employees",
			parent_label: "Manager",
			child_label: "Report",
			translation_group: "shared_tg",
		};

		await ctx.db
			.insertInto("_emdash_relations")
			.values({ id: "g_en", name: "manages", locale: "en", ...base })
			.execute();

		// Same (translation_group, locale) -> rejected by the partial unique,
		// even though `name` differs.
		await expect(
			ctx.db
				.insertInto("_emdash_relations")
				.values({ id: "g_en2", name: "leads", locale: "en", ...base })
				.execute(),
		).rejects.toThrow();

		// Same translation_group, different locale -> allowed.
		await ctx.db
			.insertInto("_emdash_relations")
			.values({ id: "g_fr", name: "gere", locale: "fr", ...base })
			.execute();

		const rows = await ctx.db
			.selectFrom("_emdash_relations")
			.select(["id", "locale"])
			.where("translation_group", "=", "shared_tg")
			.execute();
		expect(rows).toHaveLength(2);
	});

	it("rejects a relation with a null translation_group", async () => {
		// translation_group is NOT NULL: a relation must be addressable by edges
		// (`_emdash_content_references.relation_group` is NOT NULL), so a null
		// group would be an unreferenceable, dead row.
		await expect(
			ctx.db
				.insertInto("_emdash_relations")
				.values({
					id: "n1",
					name: "manages",
					parent_collection: "employees",
					child_collection: "employees",
					parent_label: "Manager",
					child_label: "Report",
					locale: "en",
					translation_group: null as unknown as string,
				})
				.execute(),
		).rejects.toThrow();
	});

	it("forward and backlink traversal return the expected rows", async () => {
		// Parent p1 references children c1, c2 (ordered); p2 also references c1.
		await ctx.db
			.insertInto("_emdash_content_references")
			.values([
				{ id: "e1", relation_group: "r1", parent_group: "p1", child_group: "c1", sort_order: 0 },
				{ id: "e2", relation_group: "r1", parent_group: "p1", child_group: "c2", sort_order: 1 },
				{ id: "e3", relation_group: "r1", parent_group: "p2", child_group: "c1", sort_order: 0 },
			])
			.execute();

		// Forward: p1's children for relation r1, ordered.
		const children = await ctx.db
			.selectFrom("_emdash_content_references")
			.select("child_group")
			.where("parent_group", "=", "p1")
			.where("relation_group", "=", "r1")
			.orderBy("sort_order")
			.execute();
		expect(children.map((r) => r.child_group)).toEqual(["c1", "c2"]);

		// Backlink: who references c1 (any parent) for relation r1.
		const parents = await ctx.db
			.selectFrom("_emdash_content_references")
			.select("parent_group")
			.where("child_group", "=", "c1")
			.where("relation_group", "=", "r1")
			.orderBy("parent_group")
			.execute();
		expect(parents.map((r) => r.parent_group)).toEqual(["p1", "p2"]);
	});

	it("allows same-collection and self references", async () => {
		// Self reference: parent_group === child_group is permitted.
		await ctx.db
			.insertInto("_emdash_content_references")
			.values({ id: "self1", relation_group: "r1", parent_group: "x1", child_group: "x1" })
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
			"idx__emdash_relations_locale",
			"idx__emdash_relations_translation_group",
			"idx__emdash_relations_parent_collection",
			"idx__emdash_relations_child_collection",
			"idx__emdash_relations_group_locale_unique",
			"idx__emdash_content_references_parent",
			"idx__emdash_content_references_child",
			"idx__emdash_content_references_relation",
		]) {
			expect(names.has(idx), `missing index ${idx}`).toBe(true);
		}
	});

	it("down() drops both tables and up() can recreate them", async () => {
		const { down, up } = await import("../../../src/database/migrations/043_content_references.js");

		await down(ctx.db);

		// Tables gone: a raw query against them should reject.
		await expect(sql`SELECT 1 FROM _emdash_content_references`.execute(ctx.db)).rejects.toThrow();
		await expect(sql`SELECT 1 FROM _emdash_relations`.execute(ctx.db)).rejects.toThrow();

		// Re-applying up() restores them.
		await up(ctx.db);
		const rows = await ctx.db.selectFrom("_emdash_relations").selectAll().execute();
		expect(Array.isArray(rows)).toBe(true);
	});
});
