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

describeEachDialect("Loader taxonomy term filter", (dialectName: DialectName) => {
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
		const result = await handleContentCreate(db, "post", {
			data: { title },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	/**
	 * Insert a taxonomy term and return its id. `category` and `tag` are the
	 * default taxonomy defs seeded by migration 006, so both are recognized as
	 * taxonomy keys by the `where` filter. We use `id` as the value stored in
	 * `content_taxonomies.taxonomy_id` (these terms have no translations, so the
	 * row id coincides with the translation_group the pivot references).
	 */
	async function term(name: string, slug: string) {
		const id = `tax_${name}_${slug}_${termSeq++}`;
		await db
			.insertInto("taxonomies" as never)
			.values({ id, name, slug, label: slug, translation_group: id } as never)
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

	it("filters by a single taxonomy term", async () => {
		const news = await term("category", "news");
		const a = await createPost("In News");
		await createPost("Untagged");
		await tag(a.id, news);

		const result = await load({ category: "news" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("In News");
	});

	it("ANDs across two taxonomies — only entries tagged in BOTH match (#1479)", async () => {
		const news = await term("category", "news");
		const featured = await term("tag", "featured");

		const both = await createPost("News + Featured");
		const newsOnly = await createPost("News Only");
		const featuredOnly = await createPost("Featured Only");

		await tag(both.id, news);
		await tag(both.id, featured);
		await tag(newsOnly.id, news);
		await tag(featuredOnly.id, featured);

		// Before the fix, the second taxonomy key ("tag") was silently dropped
		// and this returned both "News + Featured" and "News Only".
		const result = await load({ category: ["news"], tag: ["featured"] });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("News + Featured");
	});

	it("ORs slugs within a taxonomy while ANDing across taxonomies", async () => {
		const news = await term("category", "news");
		const sports = await term("category", "sports");
		const featured = await term("tag", "featured");

		// Matches: in (news OR sports) AND featured.
		const a = await createPost("News + Featured");
		const b = await createPost("Sports + Featured");
		const c = await createPost("News, not Featured");

		await tag(a.id, news);
		await tag(a.id, featured);
		await tag(b.id, sports);
		await tag(b.id, featured);
		await tag(c.id, news);

		const result = await load({ category: ["news", "sports"], tag: ["featured"] });

		const titles = result.entries.map((e) => e.data.title);
		expect(titles).toHaveLength(2);
		expect(titles).toContain("News + Featured");
		expect(titles).toContain("Sports + Featured");
	});

	it("returns no entries when any one taxonomy filter is an empty array", async () => {
		const news = await term("category", "news");
		const post = await createPost("In News");
		await tag(post.id, news);

		// `category` matches, but the empty `tag` array short-circuits the whole
		// query to empty rather than emitting `t.slug IN ()`.
		const result = await load({ category: ["news"], tag: [] });

		expect(result.entries).toHaveLength(0);
	});
});
