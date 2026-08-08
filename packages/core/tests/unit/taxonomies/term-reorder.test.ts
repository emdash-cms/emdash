/**
 * Manual term ordering.
 *
 * Terms carry an explicit position within their sibling group, and that
 * position belongs to the translation_group rather than to a row — a term sits
 * in the same place in every locale it is translated into.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	handleTermCreate,
	handleTermList,
	handleTermReorder,
} from "../../../src/api/handlers/taxonomies.js";
import {
	down as dropSortOrder,
	up as mintSortOrder,
} from "../../../src/database/migrations/056_taxonomy_term_sort_order.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// Mock loader.getDb so the runtime taxonomy functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
	resetTaxonomyNamesCache: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import {
	getTaxonomyTerms,
	invalidateTermCache,
	resetTaxonomyDefsCacheForTests,
} from "../../../src/taxonomies/index.js";

describeEachDialect("taxonomy term reorder", (dialect) => {
	let ctx: DialectTestContext;
	let repo: TaxonomyRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new TaxonomyRepository(ctx.db);
		vi.mocked(getDb).mockResolvedValue(ctx.db);
		resetTaxonomyDefsCacheForTests();
		invalidateTermCache();
	});

	afterEach(async () => {
		invalidateTermCache();
		await teardownForDialect(ctx);
		vi.restoreAllMocks();
	});

	/** Labels of the terms in `category`, in list order. */
	async function listLabels(): Promise<string[]> {
		const result = await handleTermList(ctx.db, "category", { includeCounts: false });
		if (!result.success) throw new Error(result.error.message);
		return result.data.terms.map((term) => term.label);
	}

	/** Labels of `category` in one locale, in list order. */
	async function listLocaleLabels(locale: string): Promise<string[]> {
		const result = await handleTermList(ctx.db, "category", { locale, includeCounts: false });
		if (!result.success) throw new Error(result.error.message);
		return result.data.terms.map((term) => term.label);
	}

	/** Labels of one parent's children, in list order. */
	async function listChildLabels(parentLabel: string): Promise<string[]> {
		const result = await handleTermList(ctx.db, "category", { includeCounts: false });
		if (!result.success) throw new Error(result.error.message);
		const parent = result.data.terms.find((term) => term.label === parentLabel);
		if (!parent) throw new Error(`no root term labelled ${parentLabel}`);
		return parent.children.map((term) => term.label);
	}

	async function createCategories(labels: string[]) {
		const created = [];
		for (const label of labels) {
			created.push(await repo.create({ name: "category", slug: label.toLowerCase(), label }));
		}
		return created;
	}

	it("lists a group in the order its terms were created", async () => {
		await createCategories(["Zebra", "Apple", "Mango"]);

		expect(await listLabels()).toEqual(["Zebra", "Apple", "Mango"]);
	});

	it("lists a group in the order it was given", async () => {
		const [zebra, apple, mango] = await createCategories(["Zebra", "Apple", "Mango"]);

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [apple!.id, mango!.id, zebra!.id],
		});

		expect(result.success).toBe(true);
		expect(await listLabels()).toEqual(["Apple", "Mango", "Zebra"]);
	});

	it("reflects the order in the public runtime helper", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);

		await handleTermReorder(ctx.db, "category", { ids: [apple!.id, zebra!.id] });
		invalidateTermCache();

		const terms = await getTaxonomyTerms("category", { includeCounts: false });
		expect(terms.map((term) => term.label)).toEqual(["Apple", "Zebra"]);
	});

	it("adds a new term to the end of its group", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		await handleTermReorder(ctx.db, "category", { ids: [apple!.id, zebra!.id] });

		const created = await handleTermCreate(ctx.db, "category", { slug: "banana", label: "Banana" });

		expect(created.success).toBe(true);
		expect(await listLabels()).toEqual(["Apple", "Zebra", "Banana"]);
	});

	it("orders each parent's children independently of the roots", async () => {
		const [alpha, beta] = await createCategories(["Alpha", "Beta"]);
		const childA = await repo.create({
			name: "category",
			slug: "child-a",
			label: "Child A",
			parentId: alpha!.id,
		});
		const childZ = await repo.create({
			name: "category",
			slug: "child-z",
			label: "Child Z",
			parentId: alpha!.id,
		});

		// Reordering the children leaves the roots alone...
		await handleTermReorder(ctx.db, "category", {
			parentId: alpha!.translationGroup,
			ids: [childZ.id, childA.id],
		});
		expect(await listLabels()).toEqual(["Alpha", "Beta"]);
		expect(await listChildLabels("Alpha")).toEqual(["Child Z", "Child A"]);

		// ...and reordering the roots leaves the children as they were.
		await handleTermReorder(ctx.db, "category", { ids: [beta!.id, alpha!.id] });
		expect(await listLabels()).toEqual(["Beta", "Alpha"]);
		expect(await listChildLabels("Alpha")).toEqual(["Child Z", "Child A"]);
	});

	it("appends a reparented term to the group it lands in", async () => {
		const [alpha, beta] = await createCategories(["Alpha", "Beta"]);
		const childA = await repo.create({
			name: "category",
			slug: "child-a",
			label: "Child A",
			parentId: alpha!.id,
		});
		const childZ = await repo.create({
			name: "category",
			slug: "child-z",
			label: "Child Z",
			parentId: alpha!.id,
		});
		await handleTermReorder(ctx.db, "category", {
			parentId: alpha!.translationGroup,
			ids: [childZ.id, childA.id],
		});

		// Beta's position as a root says nothing about where it belongs among
		// Alpha's children, so it joins them at the end.
		await repo.update(beta!.id, { parentId: alpha!.translationGroup ?? alpha!.id });

		expect(await listChildLabels("Alpha")).toEqual(["Child Z", "Child A", "Beta"]);
	});

	it("rejects a term that is not in the group, without reordering", async () => {
		const [alpha] = await createCategories(["Alpha", "Beta"]);
		const child = await repo.create({
			name: "category",
			slug: "child-a",
			label: "Child A",
			parentId: alpha!.id,
		});

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [child.id, alpha!.id],
		});

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected a mismatch");
		expect(result.error.code).toBe("REORDER_MISMATCH");
		expect(await listLabels()).toEqual(["Alpha", "Beta"]);
	});

	it("rejects a list naming the same term twice", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [zebra!.id, zebra!.id, apple!.id],
		});

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected a mismatch");
		expect(result.error.code).toBe("REORDER_MISMATCH");
		expect(await listLabels()).toEqual(["Zebra", "Apple"]);
	});

	it("rejects a term that belongs to another taxonomy", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		const tag = await repo.create({ name: "tag", slug: "news", label: "News" });

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [zebra!.id, apple!.id, tag.id],
		});

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected a mismatch");
		expect(result.error.code).toBe("REORDER_MISMATCH");
	});

	// -----------------------------------------------------------------------
	// A position belongs to the term, not to one of its locales
	// -----------------------------------------------------------------------

	/**
	 * Translate `source` into `locale`, returning the new row's id. Carries the
	 * source's parent through the way the translations route does.
	 */
	async function translate(
		source: { id: string; slug: string; parentId: string | null },
		locale: string,
		label: string,
	) {
		const result = await handleTermCreate(ctx.db, "category", {
			slug: `${source.slug}-${locale}`,
			label,
			locale,
			parentId: source.parentId,
			translationOf: source.id,
		});
		if (!result.success) throw new Error(result.error.message);
		return result.data.term.id;
	}

	it("gives a translation the position of the term it translates", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		await handleTermReorder(ctx.db, "category", { ids: [apple!.id, zebra!.id] });

		await translate(zebra!, "es", "Zebra ES");
		await translate(apple!, "es", "Apple ES");

		expect(await listLocaleLabels("es")).toEqual(["Apple ES", "Zebra ES"]);
	});

	it("applies an order set from one locale to every other locale", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		await translate(zebra!, "es", "Zebra ES");
		await translate(apple!, "es", "Apple ES");

		// Reordering names the EN rows; the ES rows move with them.
		await handleTermReorder(ctx.db, "category", { ids: [apple!.id, zebra!.id] });

		expect(await listLocaleLabels("en")).toEqual(["Apple", "Zebra"]);
		expect(await listLocaleLabels("es")).toEqual(["Apple ES", "Zebra ES"]);
	});

	it("accepts a translation_group in place of a row id", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [apple!.translationGroup!, zebra!.translationGroup!],
		});

		expect(result.success).toBe(true);
		expect(await listLabels()).toEqual(["Apple", "Zebra"]);
	});

	it("keeps every row of a reparented term at one position", async () => {
		const [alpha, beta] = await createCategories(["Alpha", "Beta"]);
		await translate(beta!, "es", "Beta ES");

		await repo.update(beta!.id, { parentId: alpha!.translationGroup ?? alpha!.id });

		const rows = await repo.findTranslations(beta!.translationGroup!);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.sortOrder)).size).toBe(1);
	});

	it("permutes a partly visible group within the slots it occupies", async () => {
		const [alpha, , gamma] = await createCategories(["Alpha", "Beta", "Gamma"]);
		// Beta is never translated, so an admin working in ES cannot name it.
		await translate(alpha!, "es", "Alpha ES");
		await translate(gamma!, "es", "Gamma ES");

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [gamma!.translationGroup!, alpha!.translationGroup!],
		});

		expect(result.success).toBe(true);
		// Gamma and Alpha swap the slots they held (0 and 2); Beta keeps slot 1.
		expect(await listLocaleLabels("en")).toEqual(["Gamma", "Beta", "Alpha"]);
		expect(await listLocaleLabels("es")).toEqual(["Gamma ES", "Alpha ES"]);
	});

	it("leaves a term out of the list alone rather than burying it", async () => {
		const [alpha, beta] = await createCategories(["Alpha", "Beta", "Gamma"]);

		// A stale client that never saw Gamma reorders the two it knows about.
		const result = await handleTermReorder(ctx.db, "category", {
			ids: [beta!.id, alpha!.id],
		});

		expect(result.success).toBe(true);
		expect(await listLabels()).toEqual(["Beta", "Alpha", "Gamma"]);
	});

	it("refuses to reorder a child whose parent is not translated as a root", async () => {
		const [alpha] = await createCategories(["Alpha"]);
		const child = await repo.create({
			name: "category",
			slug: "child-a",
			label: "Child A",
			parentId: alpha!.id,
		});
		const esRoot = await handleTermCreate(ctx.db, "category", {
			slug: "uno",
			label: "Uno",
			locale: "es",
		});
		if (!esRoot.success) throw new Error(esRoot.error.message);
		const esChild = await translate(child, "es", "Child A ES");

		// Alpha has no ES row, so the term list shows the child at the ES top
		// level — but it belongs to Alpha's group, not to the roots.
		expect(await listLocaleLabels("es")).toEqual(["Child A ES", "Uno"]);

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [esRoot.data.term.id, esChild],
		});

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected a mismatch");
		expect(result.error.code).toBe("REORDER_MISMATCH");
	});

	// -----------------------------------------------------------------------
	// Migration 056
	// -----------------------------------------------------------------------

	it("mints positions that preserve the alphabetical order terms had before", async () => {
		const [alpha] = await createCategories(["Zebra", "Apple", "Mango"]);
		await repo.create({
			name: "category",
			slug: "child-z",
			label: "Child Z",
			parentId: alpha!.id,
		});
		await repo.create({
			name: "category",
			slug: "child-a",
			label: "Child A",
			parentId: alpha!.id,
		});

		await dropSortOrder(ctx.db);
		await mintSortOrder(ctx.db);
		invalidateTermCache();

		// `alpha` here is Zebra — the first label passed to createCategories.
		expect(await listLabels()).toEqual(["Apple", "Mango", "Zebra"]);
		expect(await listChildLabels("Zebra")).toEqual(["Child A", "Child Z"]);
	});

	it("mints one position per translation group", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		await translate(zebra!, "es", "Zebra ES");
		await translate(apple!, "es", "Apple ES");

		await dropSortOrder(ctx.db);
		await mintSortOrder(ctx.db);
		invalidateTermCache();

		for (const term of [zebra!, apple!]) {
			const rows = await repo.findTranslations(term.translationGroup!);
			expect(rows).toHaveLength(2);
			expect(new Set(rows.map((row) => row.sortOrder)).size).toBe(1);
		}
		expect(await listLocaleLabels("es")).toEqual(["Apple ES", "Zebra ES"]);
	});
});
