import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { getTermCountsForCollection } from "../../src/loader.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../utils/test-db.js";

/**
 * `getTermCountsForCollection` returns per-term entry counts for a collection's
 * `(status, locale)` slice, keyed by `translation_group`. These are the numbers
 * that drive the loader's seek-vs-scan decision, so they must mirror the query
 * being planned — the count follows the query's own status/locale/collection,
 * we never impose "published".
 */
describeEachDialect("getTermCountsForCollection", (dialectName: DialectName) => {
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

	async function createPost(
		title: string,
		opts: { status?: "draft" | "published"; locale?: string } = {},
	) {
		const result = await handleContentCreate(db, "post", {
			data: { title },
			status: opts.status ?? "published",
			...(opts.locale ? { locale: opts.locale } : {}),
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	/** Insert a term whose row id doubles as its translation_group. */
	async function term(name: string, slug: string, locale = "en", translationGroup?: string) {
		const id = `tax_${name}_${slug}_${locale}_${seq++}`;
		await db
			.insertInto("taxonomies" as never)
			.values({
				id,
				name,
				slug,
				label: slug,
				locale,
				translation_group: translationGroup ?? id,
			} as never)
			.execute();
		return translationGroup ?? id;
	}

	async function tag(collection: string, entryId: string, group: string) {
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection, entry_id: entryId, taxonomy_id: group } as never)
			.execute();
	}

	it("counts only entries matching the query status; total tracks it too", async () => {
		const news = await term("category", "news");
		const published = await createPost("Published", { status: "published" });
		const draft = await createPost("Draft", { status: "draft" });
		await createPost("Untagged published", { status: "published" });
		await tag("post", published.id, news);
		await tag("post", draft.id, news);

		const pub = await getTermCountsForCollection(db, "post", "published", undefined);
		expect(pub.total).toBe(2); // both published posts, draft excluded
		expect(pub.terms.get(news)).toMatchObject({
			translationGroup: news,
			name: "category",
			slug: "news",
			count: 1, // only the published tagged post
		});

		// A draft query counts drafts — the count follows the query, not a fixed
		// "published" choice.
		const drafts = await getTermCountsForCollection(db, "post", "draft", undefined);
		expect(drafts.total).toBe(1);
		expect(drafts.terms.get(news)?.count).toBe(1);
	});

	it("counts within the query locale for both content and term rows", async () => {
		// One term group with EN + FR variants; one published entry per locale.
		const group = await term("category", "news", "en");
		await term("category", "actualites", "fr", group);

		const en = await createPost("EN", { locale: "en" });
		const fr = await createPost("FR", { locale: "fr" });
		await tag("post", en.id, group);
		await tag("post", fr.id, group);

		const enCounts = await getTermCountsForCollection(db, "post", "published", "en");
		expect(enCounts.total).toBe(1);
		expect(enCounts.terms.get(group)).toMatchObject({ slug: "news", count: 1 });

		const frCounts = await getTermCountsForCollection(db, "post", "published", "fr");
		expect(frCounts.total).toBe(1);
		expect(frCounts.terms.get(group)).toMatchObject({ slug: "actualites", count: 1 });
	});

	it("scopes counts to the queried collection for a shared term", async () => {
		const news = await term("category", "news");
		const post = await createPost("Post");
		await tag("post", post.id, news);

		const pageResult = await handleContentCreate(db, "page", {
			data: { title: "Page" },
			status: "published",
		});
		if (!pageResult.success) throw new Error("Failed to create page");
		await tag("page", pageResult.data!.item.id, news);

		const postCounts = await getTermCountsForCollection(db, "post", "published", undefined);
		expect(postCounts.terms.get(news)?.count).toBe(1);

		const pageCounts = await getTermCountsForCollection(db, "page", "published", undefined);
		expect(pageCounts.terms.get(news)?.count).toBe(1);
	});
});
