import { afterEach, beforeEach, expect, it } from "vitest";

import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const TAXONOMY = "paged_category";

interface TermFixture {
	id: string;
	slug: string;
	label: string;
	sortOrder: number;
	locale?: string;
}

describeEachDialect("TaxonomyRepository pagination", (dialect) => {
	let ctx: DialectTestContext;
	let repo: TaxonomyRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new TaxonomyRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function insertTerms(terms: TermFixture[]): Promise<void> {
		await ctx.db
			.insertInto("taxonomies")
			.values(
				terms.map((term) => ({
					id: term.id,
					name: TAXONOMY,
					slug: term.slug,
					label: term.label,
					parent_id: null,
					data: null,
					locale: term.locale ?? "en",
					translation_group: term.id,
					sort_order: term.sortOrder,
				})),
			)
			.execute();
	}

	it("pages by sort order, label, and id", async () => {
		await insertTerms([
			{ id: "term-z", slug: "first", label: "Zulu", sortOrder: 0 },
			{ id: "term-b", slug: "tie-b", label: "Alpha", sortOrder: 1 },
			{ id: "term-a", slug: "tie-a", label: "Alpha", sortOrder: 1 },
			{ id: "term-c", slug: "last", label: "Bravo", sortOrder: 1 },
			{ id: "term-fr", slug: "french", label: "Aardvark", sortOrder: 0, locale: "fr" },
		]);

		const page1 = await repo.findPageByName(TAXONOMY, {
			locale: "en",
			limit: 2,
		});
		expect(page1.items.map((term) => term.slug)).toEqual(["first", "tie-a"]);
		expect(page1.hasMore).toBe(true);

		const last = page1.items.at(-1)!;
		await ctx.db.deleteFrom("taxonomies").where("id", "=", last.id).execute();
		const page2 = await repo.findPageByName(TAXONOMY, {
			locale: "en",
			limit: 2,
			cursor: { sortOrder: last.sortOrder, label: last.label, id: last.id },
		});
		expect(page2.items.map((term) => term.slug)).toEqual(["tie-b", "last"]);
		expect(page2.hasMore).toBe(false);
	});

	it("caps each page at 100 items", async () => {
		await insertTerms(
			Array.from({ length: 101 }, (_, index) => ({
				id: `term-${String(index).padStart(3, "0")}`,
				slug: `term-${index}`,
				label: `Term ${String(index).padStart(3, "0")}`,
				sortOrder: index,
			})),
		);

		const page = await repo.findPageByName(TAXONOMY, { limit: 1000 });
		expect(page.items).toHaveLength(100);
		expect(page.hasMore).toBe(true);
	});
});
