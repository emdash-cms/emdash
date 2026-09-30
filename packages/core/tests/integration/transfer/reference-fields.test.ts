/**
 * Reference fields bound to a relation keep their values as content
 * references, not in a column. A site transfer carries the relation, the
 * edges and the fields' bindings, and the target creates no column for a
 * bound field. An unbound reference field keeps its column.
 */

import { sql, type Kysely } from "kysely";
import { afterEach, expect, it } from "vitest";

import { bindReferenceField } from "../../../src/api/handlers/schema.js";
import { listTableColumns } from "../../../src/database/dialect-helpers.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite, type OriginSite } from "../../utils/transfer/origin-site.js";
import {
	analyze,
	executePlan,
	exportOrigin,
	phase,
	runImport,
	seedTarget,
	TARGET_BOB,
	uploadPackage,
} from "./pipeline.js";

async function columnsOf(db: Kysely<Database>, table: string): Promise<string[]> {
	return (await listTableColumns(db, table)).map((column) => column.name);
}

async function relations(db: Kysely<Database>) {
	return db.selectFrom("_emdash_relations").selectAll().orderBy("id").execute();
}

async function edges(db: Kysely<Database>) {
	return db
		.selectFrom("_emdash_content_references")
		.select(["id", "relation_id", "parent_group", "child_group", "sort_order"])
		.orderBy("id")
		.execute();
}

async function referenceFields(db: Kysely<Database>) {
	const rows = await db
		.selectFrom("_emdash_fields")
		.select(["id", "slug", "validation"])
		.where("type", "=", "reference")
		.orderBy("id")
		.execute();
	return rows.map((row) => ({
		...row,
		validation: row.validation === null ? null : (JSON.parse(row.validation) as unknown),
	}));
}

async function postGroup(db: Kysely<Database>, id: string): Promise<string> {
	const row = await db
		.selectFrom("ec_posts" as never)
		.select(sql<string>`translation_group`.as("group"))
		.where(sql.ref("id"), "=", id)
		.executeTakeFirstOrThrow();
	return (row as { group: string }).group;
}

describeEachDialect("transferring reference fields bound to relations", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	async function transfer(site: OriginSite, originStorage: ReturnType<typeof createMemoryStorage>) {
		await seedTarget(target!.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const targetStorage = createMemoryStorage();
		const operationId = await uploadPackage(
			target!.db,
			targetStorage,
			await exportOrigin(phase(source!.db), originStorage),
		);
		const analysis = await analyze(phase(target!.db), targetStorage, operationId);
		expect(analysis.plan?.blockers).toEqual([]);
		await executePlan(target!.db, targetStorage, operationId, {
			[site.ids.alice]: null,
			[site.ids.bob]: TARGET_BOB,
		});
		const result = await runImport(phase(target!.db), targetStorage, operationId);
		expect(result.operation.errorDetail).toBeNull();
		expect(result.operation.state).toBe("complete");
		return analysis.plan!;
	}

	it("carries relations, edges and bindings without a column", { timeout: 300_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		const registry = new SchemaRegistry(source.db);
		const relationRepo = new RelationRepository(source.db);

		const features = await relationRepo.create({
			slug: "page_features",
			parentCollection: "pages",
			childCollection: "posts",
			parentLabel: "Pages",
			parentLabelSingular: "Page",
			childLabel: "Featured posts",
			childLabelSingular: "Featured post",
			maxChildrenPerParent: 3,
			maxParentsPerChild: 1,
		});
		await registry.createField("pages", {
			slug: "features",
			label: "Features",
			type: "reference",
			validation: {
				relation: features.slug,
				relationSide: "parent",
				targetCollection: "posts",
				multiple: true,
			},
		});
		await registry.createField("posts", {
			slug: "featured_on",
			label: "Featured on",
			type: "reference",
			validation: {
				relation: features.slug,
				relationSide: "child",
				targetCollection: "pages",
				multiple: false,
			},
		});
		const featured = [
			await postGroup(source.db, site.ids.scheduledPost),
			await postGroup(source.db, site.ids.hello),
			await postGroup(source.db, site.ids.draftPost),
		];
		expect(await relationRepo.setChildren(features.slug, site.ids.about, featured)).toEqual([]);

		// A field bound after it already held values keeps its old column.
		await registry.createField("posts", { slug: "pick", label: "Pick", type: "reference" });
		await sql`UPDATE ec_posts SET pick = ${site.ids.about} WHERE id = ${site.ids.hello}`.execute(
			source.db,
		);
		const pick = await registry.getField("posts", "pick");
		await bindReferenceField(source.db, "posts", pick!, {}, "pages");
		expect(await columnsOf(source.db, "ec_posts")).toContain("pick");

		await transfer(site, originStorage);

		const postColumns = await columnsOf(target.db, "ec_posts");
		expect(postColumns).not.toContain("featured_on");
		expect(postColumns).not.toContain("pick");
		expect(postColumns).toContain("related");
		expect(await columnsOf(target.db, "ec_pages")).not.toContain("features");

		expect(await relations(target.db)).toEqual(await relations(source.db));
		const targetEdges = await edges(target.db);
		expect(targetEdges).toEqual(await edges(source.db));
		expect(
			targetEdges
				.filter((edge) => edge.relation_id === features.id)
				.toSorted((a, b) => Number(a.sort_order) - Number(b.sort_order))
				.map((edge) => edge.child_group),
		).toEqual(featured);
		expect(await referenceFields(target.db)).toEqual(await referenceFields(source.db));

		const targetRelations = new RelationRepository(target.db);
		const imported = await targetRelations.findBySlug(features.slug);
		expect(imported).toMatchObject({ maxChildrenPerParent: 3, maxParentsPerChild: 1 });
	});

	it(
		"imports a field bound to a deleted relation with a warning",
		{ timeout: 300_000 },
		async () => {
			source = await setupForDialect(dialect);
			target = await setupForDialect(dialect);
			const originStorage = createMemoryStorage();
			const site = await buildOriginSite(source.db, originStorage);
			const relationRepo = new RelationRepository(source.db);
			const gone = await relationRepo.create({
				slug: "gone",
				parentCollection: "posts",
				childCollection: "pages",
				parentLabel: "Posts",
				childLabel: "Pages",
			});
			const field = await new SchemaRegistry(source.db).createField("posts", {
				slug: "orphaned",
				label: "Orphaned",
				type: "reference",
				validation: { relation: gone.slug, relationSide: "parent", targetCollection: "pages" },
			});
			await relationRepo.delete(gone.id);

			const plan = await transfer(site, originStorage);

			expect(plan.warnings).toContainEqual(
				expect.objectContaining({
					code: "soft_reference_dangling",
					kind: "field",
					id: field.id,
				}),
			);
			expect(await columnsOf(target.db, "ec_posts")).not.toContain("orphaned");
			expect(await referenceFields(target.db)).toEqual(await referenceFields(source.db));
		},
	);
});
