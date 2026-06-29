import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("Loader taxonomy subtree filter", (dialectName: DialectName) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let termSeq = 0;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialectName);
		db = ctx.db;
		termSeq = 0;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPost(title: string) {
		const result = await handleContentCreate(db, "post", { data: { title }, status: "published" });
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	// parentId is the parent's translation_group (== parent id for untranslated terms).
	async function term(name: string, slug: string, parentId?: string) {
		const id = `tax_${name}_${slug}_${termSeq++}`;
		await db
			.insertInto("taxonomies" as never)
			.values({
				id,
				name,
				slug,
				label: slug,
				translation_group: id,
				parent_id: parentId ?? null,
			} as never)
			.execute();
		return id;
	}

	async function tag(contentId: string, taxonomyId: string) {
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection: "post", entry_id: contentId, taxonomy_id: taxonomyId } as never)
			.execute();
	}

	function load(where: Record<string, unknown>) {
		const loader = emdashLoader();
		return runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", where: where as never } }),
		);
	}

	it("matches a term and its descendants (single root)", async () => {
		const region = await term("category", "region");
		const north = await term("category", "north", region);
		const city = await term("category", "city", north);

		const rootPost = await createPost("Tagged at root");
		const leafPost = await createPost("Tagged at leaf");
		const outsidePost = await createPost("Outside subtree");
		const other = await term("category", "south", region);

		await tag(rootPost.id, north);
		await tag(leafPost.id, city);
		await tag(outsidePost.id, other);

		const result = await load({ category: { subtree: "north" } });

		const titles = result.entries.map((e) => e.data.title).toSorted();
		expect(titles).toEqual(["Tagged at leaf", "Tagged at root"]);
	});
});
