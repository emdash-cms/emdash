import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../../src/api/index.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("Taxonomy subtree counts", (dialectName: DialectName) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let seq = 0;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialectName);
		db = ctx.db;
		seq = 0;
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function term(slug: string, parentId?: string) {
		const id = `tax_category_${slug}_${seq++}`;
		await db
			.insertInto("taxonomies" as never)
			.values({
				id,
				name: "category",
				slug,
				label: slug,
				translation_group: id,
				parent_id: parentId ?? null,
			} as never)
			.execute();
		return id;
	}
	async function post(title: string) {
		const r = await handleContentCreate(db, "post", { data: { title }, status: "published" });
		if (!r.success) throw new Error("create failed");
		return r.data!.item;
	}
	async function tag(contentId: string, group: string) {
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection: "post", entry_id: contentId, taxonomy_id: group } as never)
			.execute();
	}

	it("rolls descendant counts up to ancestors as DISTINCT entries", async () => {
		const region = await term("region");
		const north = await term("north", region);
		const city = await term("city", north);

		const a = await post("a");
		const b = await post("b");
		await tag(a.id, city);
		await tag(b.id, north);
		// Entry tagged at BOTH a parent and its child must count once at the root.
		await tag(a.id, north);

		const repo = new TaxonomyRepository(db);
		const counts = await repo.countEntriesForSubtrees("category");

		expect(counts.get(region)).toBe(2); // a + b, distinct (not 3)
		expect(counts.get(north)).toBe(2); // a (via city + direct) + b, distinct
		expect(counts.get(city)).toBe(1); // a
	});

	it("counts an entry once at a shared ancestor across sibling subtrees", async () => {
		// region -> {north -> city, south}. An entry tagged under both `city`
		// (deep in north) and `south` (a sibling subtree) must count ONCE at the
		// shared `region` ancestor. A rollup that sums child counts would report 2.
		const region = await term("region");
		const north = await term("north", region);
		const city = await term("city", north);
		const south = await term("south", region);

		const a = await post("a");
		await tag(a.id, city);
		await tag(a.id, south);

		const repo = new TaxonomyRepository(db);
		const counts = await repo.countEntriesForSubtrees("category");

		expect(counts.get(region)).toBe(1); // distinct across both subtrees
		expect(counts.get(north)).toBe(1);
		expect(counts.get(city)).toBe(1);
		expect(counts.get(south)).toBe(1);
	});

	it("returns no entry for terms whose subtree has no assignments", async () => {
		const region = await term("region");
		await term("north", region);

		const repo = new TaxonomyRepository(db);
		const counts = await repo.countEntriesForSubtrees("category");

		expect(counts.size).toBe(0);
	});

	it("getTaxonomyTerms({ rollup }) returns subtree counts on the tree", async () => {
		const { getTaxonomyTerms } = await import("../../../src/taxonomies/index.js");
		const { runWithContext } = await import("../../../src/request-context.js");

		const region = await term("region");
		const north = await term("north", region);
		const a = await post("a");
		const b = await post("b");
		await tag(a.id, north);
		await tag(b.id, region);

		const tree = await runWithContext({ editMode: false, db }, () =>
			getTaxonomyTerms("category", { rollup: true }),
		);
		const root = tree.find((t) => t.slug === "region");
		expect(root?.count).toBe(2); // a (under north) + b (direct)

		const flat = await runWithContext({ editMode: false, db }, () => getTaxonomyTerms("category"));
		const flatRoot = flat.find((t) => t.slug === "region");
		expect(flatRoot?.count).toBe(1); // exact-term only
	});

	it("handleTermList({ rollup }) rolls counts up the tree", async () => {
		const { handleTermList } = await import("../../../src/api/handlers/taxonomies.js");

		const region = await term("region");
		const north = await term("north", region);
		const a = await post("a");
		await tag(a.id, north);

		const res = await handleTermList(db, "category", { rollup: true });
		if (!res.success) throw new Error("handleTermList failed");
		const root = res.data.terms.find((t) => t.slug === "region");
		expect(root?.count).toBe(1); // rolled up from the descendant
	});
});
