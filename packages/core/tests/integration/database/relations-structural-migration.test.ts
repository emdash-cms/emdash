import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { columnExists, tableExists } from "../../../src/database/dialect-helpers.js";
import * as migration076 from "../../../src/database/migrations/076_relations_structural.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface OldRelation {
	id: string;
	name: string;
	parentCollection?: string;
	childCollection?: string;
	parentLabel?: string;
	childLabel?: string;
	locale: string;
	translationGroup: string;
}

/**
 * Rebuild `_emdash_relations` in its migration-043 shape and rename the edge
 * table's relation column back, so `up` runs against the state it was written
 * for. A fresh test database has already migrated past 076.
 */
async function revertToPre076(ctx: DialectTestContext, relations: OldRelation[]): Promise<void> {
	const db = ctx.db;
	await db.schema.dropTable("_emdash_relations").ifExists().execute();
	await db.schema
		.createTable("_emdash_relations")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("parent_collection", "text", (c) => c.notNull())
		.addColumn("child_collection", "text", (c) => c.notNull())
		.addColumn("parent_label", "text", (c) => c.notNull())
		.addColumn("child_label", "text", (c) => c.notNull())
		.addColumn("locale", "text", (c) => c.notNull().defaultTo("en"))
		.addColumn("translation_group", "text", (c) => c.notNull())
		.addColumn("created_at", "text")
		.addColumn("updated_at", "text")
		.addUniqueConstraint("_emdash_relations_name_locale_unique", ["name", "locale"])
		.execute();

	for (const r of relations) {
		await sql`
			INSERT INTO ${sql.ref("_emdash_relations")}
				(id, name, parent_collection, child_collection, parent_label, child_label,
				 locale, translation_group)
			VALUES (${r.id}, ${r.name}, ${r.parentCollection ?? "post"}, ${r.childCollection ?? "page"},
			        ${r.parentLabel ?? "Posts"}, ${r.childLabel ?? "Pages"}, ${r.locale},
			        ${r.translationGroup})
		`.execute(db);
	}

	if (await columnExists(db, "_emdash_content_references", "relation_id")) {
		await sql
			.raw(
				`ALTER TABLE "_emdash_content_references" RENAME COLUMN "relation_id" TO "relation_group"`,
			)
			.execute(db);
	}
}

async function insertEdge(
	ctx: DialectTestContext,
	relationColumn: string,
	values: { id: string; relation: string; parent: string; child: string },
): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref("_emdash_content_references")}
			(id, ${sql.ref(relationColumn)}, parent_group, child_group, sort_order)
		VALUES (${values.id}, ${values.relation}, ${values.parent}, ${values.child}, 0)
	`.execute(ctx.db);
}

async function readRelations(ctx: DialectTestContext): Promise<Array<Record<string, unknown>>> {
	const result = await sql<Record<string, unknown>>`
		SELECT * FROM ${sql.ref("_emdash_relations")} ORDER BY slug ASC
	`.execute(ctx.db);
	return result.rows;
}

describeEachDialect("relations structural migration (076)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("collapses a translation group to one slugged row and keeps its edges", async () => {
		await revertToPre076(ctx, [
			{
				id: "grp1",
				name: "post_author",
				locale: "en",
				translationGroup: "grp1",
				parentLabel: "Posts",
				childLabel: "Author",
			},
			{
				id: "rel-fr",
				name: "post_author",
				locale: "fr",
				translationGroup: "grp1",
				parentLabel: "Articles",
				childLabel: "Auteur",
			},
		]);
		await insertEdge(ctx, "relation_group", {
			id: "edge1",
			relation: "grp1",
			parent: "pg1",
			child: "cg1",
		});

		await migration076.up(ctx.db);

		const rows = await readRelations(ctx);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "grp1",
			slug: "post_author",
			parent_label: "Posts",
			child_label: "Author",
		});

		const edges = await sql<{ relation_id: string; parent_group: string }>`
			SELECT relation_id, parent_group FROM ${sql.ref("_emdash_content_references")}
		`.execute(ctx.db);
		expect(edges.rows).toEqual([{ relation_id: "grp1", parent_group: "pg1" }]);
	});

	it("takes the lowest locale code's labels", async () => {
		await revertToPre076(ctx, [
			{
				id: "rel-fr",
				name: "post_author",
				locale: "fr",
				translationGroup: "grp1",
				parentLabel: "Articles",
				childLabel: "Auteur",
			},
			{
				id: "grp1",
				name: "post_author",
				locale: "de",
				translationGroup: "grp1",
				parentLabel: "Beitraege",
				childLabel: "Autor",
			},
		]);

		await migration076.up(ctx.db);

		const rows = await readRelations(ctx);
		expect(rows[0]).toMatchObject({ parent_label: "Beitraege", child_label: "Autor" });
	});

	it("suffixes a slug when two groups shared a name across locales", async () => {
		await revertToPre076(ctx, [
			{ id: "aaa", name: "post_author", locale: "en", translationGroup: "aaa" },
			{ id: "bbb", name: "post_author", locale: "fr", translationGroup: "bbb" },
		]);

		await migration076.up(ctx.db);

		const rows = await readRelations(ctx);
		expect(rows.map((r) => r.slug)).toEqual(["post_author", "post_author_2"]);
	});

	it("adds the cardinality and singular-label columns, defaulting to null", async () => {
		await revertToPre076(ctx, [
			{ id: "grp1", name: "post_author", locale: "en", translationGroup: "grp1" },
		]);

		await migration076.up(ctx.db);

		expect(await readRelations(ctx)).toEqual([
			expect.objectContaining({
				parent_label_singular: null,
				child_label_singular: null,
				max_children_per_parent: null,
				max_parents_per_child: null,
			}),
		]);
	});

	it("is a no-op on a second run", async () => {
		await revertToPre076(ctx, [
			{ id: "grp1", name: "post_author", locale: "en", translationGroup: "grp1" },
		]);
		await insertEdge(ctx, "relation_group", {
			id: "edge1",
			relation: "grp1",
			parent: "pg1",
			child: "cg1",
		});

		await migration076.up(ctx.db);
		const first = await readRelations(ctx);

		await migration076.up(ctx.db);

		expect(await readRelations(ctx)).toEqual(first);
		const edges = await sql<{ relation_id: string }>`
			SELECT relation_id FROM ${sql.ref("_emdash_content_references")}
		`.execute(ctx.db);
		expect(edges.rows).toEqual([{ relation_id: "grp1" }]);
	});

	it("recovers when a previous run stopped between the drop and the rename", async () => {
		await revertToPre076(ctx, [
			{ id: "grp1", name: "post_author", locale: "en", translationGroup: "grp1" },
		]);

		// Replay the rebuild up to the point the old table is gone and the new one
		// has not been renamed into place yet.
		await migration076.up(ctx.db);
		await sql
			.raw(`ALTER TABLE "_emdash_relations" RENAME TO "_emdash_relations_new"`)
			.execute(ctx.db);
		expect(await tableExists(ctx.db, "_emdash_relations")).toBe(false);

		await migration076.up(ctx.db);

		expect(await tableExists(ctx.db, "_emdash_relations")).toBe(true);
		expect(await tableExists(ctx.db, "_emdash_relations_new")).toBe(false);
		expect(await readRelations(ctx)).toEqual([expect.objectContaining({ slug: "post_author" })]);
	});

	it("completes the edge-column rename when a previous run stopped before it", async () => {
		await revertToPre076(ctx, [
			{ id: "grp1", name: "post_author", locale: "en", translationGroup: "grp1" },
		]);
		await insertEdge(ctx, "relation_group", {
			id: "edge1",
			relation: "grp1",
			parent: "pg1",
			child: "cg1",
		});

		await migration076.up(ctx.db);

		// The table rebuild landed but the edge-column rename did not.
		await sql
			.raw(
				`ALTER TABLE "_emdash_content_references" RENAME COLUMN "relation_id" TO "relation_group"`,
			)
			.execute(ctx.db);

		await migration076.up(ctx.db);

		expect(await columnExists(ctx.db, "_emdash_content_references", "relation_id")).toBe(true);
		expect(await columnExists(ctx.db, "_emdash_content_references", "relation_group")).toBe(false);
	});
});
