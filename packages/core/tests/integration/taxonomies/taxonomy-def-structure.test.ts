/** A taxonomy's `hierarchical` and `collections` read and write the same through every locale. */

import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleTaxonomyCreate,
	handleTaxonomyGet,
	handleTaxonomyUpdate,
} from "../../../src/api/handlers/taxonomies.js";
import {
	findTaxonomyStructure,
	saveTaxonomyStructure,
} from "../../../src/database/repositories/taxonomy-def.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { runWithContext } from "../../../src/request-context.js";
import { getTaxonomyTerms, resetTaxonomyDefsCacheForTests } from "../../../src/taxonomies/index.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("taxonomy structure is shared by every locale", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "es", "fr"] });
		resetTaxonomyDefsCacheForTests();
	});

	afterEach(async () => {
		setI18nConfig(null);
		resetTaxonomyDefsCacheForTests();
		await teardownForDialect(ctx);
	});

	async function createTopic(): Promise<string> {
		const created = await handleTaxonomyCreate(ctx.db, {
			name: "topic",
			label: "Topics",
			hierarchical: true,
			collections: ["post"],
			locale: "en",
		});
		if (!created.success) throw new Error(created.error.message);
		return created.data.taxonomy.id;
	}

	async function structureIn(locale: string) {
		const result = await handleTaxonomyGet(ctx.db, "topic", { locale });
		if (!result.success) throw new Error(result.error.message);
		const { hierarchical, collections, label, translationGroup } = result.data.taxonomy;
		return { hierarchical, collections, label, translationGroup };
	}

	it("applies a structure change made through one locale to every locale", async () => {
		const sourceId = await createTopic();
		await handleTaxonomyCreate(ctx.db, {
			name: "topic",
			label: "Temas",
			locale: "es",
			translationOf: sourceId,
		});

		const updated = await handleTaxonomyUpdate(ctx.db, "topic", {
			locale: "es",
			label: "Temas nuevos",
			hierarchical: false,
			collections: ["page"],
		});
		expect(updated.success).toBe(true);

		expect(await structureIn("en")).toMatchObject({
			label: "Topics",
			hierarchical: false,
			collections: ["page"],
		});
		expect(await structureIn("es")).toMatchObject({
			label: "Temas nuevos",
			hierarchical: false,
			collections: ["page"],
		});
		// The plugin sandbox bridges read these columns directly.
		const rows = await ctx.db
			.selectFrom("_emdash_taxonomy_defs")
			.select(["locale", "hierarchical", "collections"])
			.where("name", "=", "topic")
			.orderBy("locale", "asc")
			.execute();
		expect(rows).toEqual([
			{ locale: "en", hierarchical: 0, collections: JSON.stringify(["page"]) },
			{ locale: "es", hierarchical: 0, collections: JSON.stringify(["page"]) },
		]);
	});

	it("joins the existing taxonomy when a locale is added without translationOf", async () => {
		await createTopic();
		const created = await handleTaxonomyCreate(ctx.db, {
			name: "topic",
			label: "Sujets",
			locale: "fr",
		});
		expect(created.success).toBe(true);

		const en = await structureIn("en");
		expect(await structureIn("fr")).toEqual({
			label: "Sujets",
			hierarchical: true,
			collections: ["post"],
			translationGroup: en.translationGroup,
		});
	});

	it("rejects a new translation that sends a different structure", async () => {
		const sourceId = await createTopic();
		const differing = await handleTaxonomyCreate(ctx.db, {
			name: "topic",
			label: "Temas",
			locale: "es",
			translationOf: sourceId,
			hierarchical: false,
		});
		expect(differing.success).toBe(false);
		expect(await structureIn("en")).toMatchObject({ hierarchical: true, collections: ["post"] });

		const matching = await handleTaxonomyCreate(ctx.db, {
			name: "topic",
			label: "Sujets",
			locale: "fr",
			hierarchical: true,
			collections: ["post"],
		});
		expect(matching.success).toBe(true);
	});

	it("lists the terms of a locale that has no definition of its own", async () => {
		setI18nConfig({ defaultLocale: "ja", locales: ["ja", "en"] });
		await createTopic();
		const terms = new TaxonomyRepository(ctx.db);
		await terms.create({ name: "topic", slug: "ai", label: "AI", locale: "ja" });

		const listed = await runWithContext({ editMode: false, db: ctx.db }, () =>
			getTaxonomyTerms("topic", { locale: "ja", includeCounts: false }),
		);
		expect(listed.map((term) => term.slug)).toEqual(["ai"]);
	});

	it("changes only the structure fields a write names", async () => {
		await createTopic();
		const read = await findTaxonomyStructure(ctx.db, "topic");
		if (!read) throw new Error("topic has no structure");
		await handleTaxonomyUpdate(ctx.db, "topic", { collections: ["page"] });

		await saveTaxonomyStructure(
			ctx.db,
			"topic",
			read.id,
			{ hierarchical: false, collections: read.collections },
			{ hierarchical: false },
		);

		expect(await findTaxonomyStructure(ctx.db, "topic")).toMatchObject({
			hierarchical: false,
			collections: ["page"],
		});
	});

	it("keeps an existing taxonomy's structure when a write names no field", async () => {
		await createTopic();
		await saveTaxonomyStructure(
			ctx.db,
			"topic",
			"other-group",
			{ hierarchical: false, collections: ["page"] },
			{},
		);

		expect(await findTaxonomyStructure(ctx.db, "topic")).toMatchObject({
			hierarchical: true,
			collections: ["post"],
		});
		const rows = await ctx.db
			.selectFrom("_emdash_taxonomy_defs")
			.select(["hierarchical", "collections"])
			.where("name", "=", "topic")
			.execute();
		expect(rows).toEqual([{ hierarchical: 1, collections: JSON.stringify(["post"]) }]);
	});

	it("lets a new locale send back the structure a read returns", async () => {
		const read = await handleTaxonomyGet(ctx.db, "category", { locale: "en" });
		if (!read.success) throw new Error(read.error.message);

		const created = await handleTaxonomyCreate(ctx.db, {
			name: "category",
			label: "Categorías",
			locale: "es",
			hierarchical: read.data.taxonomy.hierarchical,
			collections: read.data.taxonomy.collections,
		});

		expect(created.success).toBe(true);
	});
});
