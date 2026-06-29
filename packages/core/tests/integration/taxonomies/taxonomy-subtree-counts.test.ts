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
});
