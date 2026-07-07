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

	async function createPost(title: string, locale?: string) {
		const result = await handleContentCreate(db, "post", {
			data: { title },
			status: "published",
			...(locale ? { locale } : {}),
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

	/**
	 * Run a taxonomy-filtered collection query. The loader auto-picks seek vs scan
	 * from cached per-term counts; results are identical either way (the choice is
	 * advisory). With no `limit` the loader always seeks — a scan reads the whole
	 * slice anyway — so unlimited queries here exercise the seek path, and the
	 * dedicated scan case below forces a scan with a limit over a non-selective
	 * term. On Postgres the loader ignores counts and always uses `EXISTS`.
	 */
	function load(where: Record<string, unknown>, opts: { locale?: string; limit?: number } = {}) {
		const loader = emdashLoader();
		return runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: where as never,
					...(opts.locale ? { locale: opts.locale } : {}),
					...(opts.limit ? { limit: opts.limit } : {}),
				},
			}),
		);
	}

	/**
	 * Insert a localized variant of an existing term: same `translation_group`
	 * as the anchor (so the `content_taxonomies` pivot, which stores the
	 * translation_group, resolves to it), but a different `locale` and `slug`.
	 * Mirrors `TaxonomyRepository.create({ translationOf })`.
	 */
	async function termTranslation(
		name: string,
		slug: string,
		locale: string,
		translationGroup: string,
	) {
		const id = `tax_${name}_${slug}_${locale}_${termSeq++}`;
		await db
			.insertInto("taxonomies" as never)
			.values({ id, name, slug, label: slug, locale, translation_group: translationGroup } as never)
			.execute();
		return id;
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

	it("does not duplicate an entry tagged with multiple OR-ed slugs of one taxonomy", async () => {
		const news = await term("category", "news");
		const sports = await term("category", "sports");

		// Tagged with BOTH slugs of the single filtered taxonomy. The seek path
		// materializes one pivot row per matching slug; without DISTINCT the
		// CROSS JOIN emitted this entry twice (single filter → no INTERSECT to
		// dedupe). The EXISTS path is a semi-join and never duplicated.
		const both = await createPost("News + Sports");
		const newsOnly = await createPost("News Only");
		await tag(both.id, news);
		await tag(both.id, sports);
		await tag(newsOnly.id, news);

		// Unlimited → seek path. DISTINCT in the driver CTE must dedupe.
		const result = await load({ category: ["news", "sports"] });
		expect(result.entries.map((e) => e.data.title).toSorted()).toEqual([
			"News + Sports",
			"News Only",
		]);
	});

	it("ORs slugs within a taxonomy while ANDing across taxonomies via the seek plan", async () => {
		const news = await term("category", "news");
		const sports = await term("category", "sports");
		const featured = await term("tag", "featured");

		// In (news OR sports) AND featured. `a` is tagged with both news AND
		// sports, so the OR-within filter must still yield it exactly once.
		const a = await createPost("News + Sports + Featured");
		const b = await createPost("Sports + Featured");
		const c = await createPost("News, not Featured");

		await tag(a.id, news);
		await tag(a.id, sports);
		await tag(a.id, featured);
		await tag(b.id, sports);
		await tag(b.id, featured);
		await tag(c.id, news);

		const result = await load({ category: ["news", "sports"], tag: ["featured"] });
		const titles = result.entries.map((e) => e.data.title).toSorted();
		expect(titles).toEqual(["News + Sports + Featured", "Sports + Featured"]);
	});

	it("scopes to the queried collection when a term is shared across collections", async () => {
		// A single global term tagged on entries in two different collections.
		// The seek path's `_matched` CTE constrains `ct.collection` to the queried
		// type ("post"), so the `page` entry's pivot row must not surface here.
		// (The outer CROSS JOIN keys on globally-unique ids so it would also drop a
		// stray page id — this asserts the observable result stays scoped, and the
		// plan-level selectivity is covered by loader-taxonomy-filter-plan.)
		const news = await term("category", "news");

		const post = await createPost("Post in News");
		await tag(post.id, news);

		const pageResult = await handleContentCreate(db, "page", {
			data: { title: "Page in News" },
			status: "published",
		});
		if (!pageResult.success) throw new Error("Failed to create page");
		const page = pageResult.data!.item;
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection: "page", entry_id: page.id, taxonomy_id: news } as never)
			.execute();

		const result = await load({ category: "news" });
		expect(result.entries.map((e) => e.data.title)).toEqual(["Post in News"]);
	});

	it("returns identical rows on the scan path (non-selective term, limited)", async () => {
		// Force the scan plan: a term on every entry with a small limit makes the
		// seek's materialized slice larger than the scan budget, so the loader
		// scans. Results must match what the seek path returns unlimited.
		const news = await term("category", "news");
		const titles: string[] = [];
		for (let i = 0; i < 6; i++) {
			const post = await createPost(`Post ${i}`);
			await tag(post.id, news);
			titles.push(`Post ${i}`);
		}

		// Unlimited (seek) sees every tagged entry.
		const seek = await load({ category: "news" });
		expect(seek.entries.map((e) => e.data.title).toSorted()).toEqual(titles.toSorted());

		// Limited over a non-selective term (scan) returns the first page, same rows
		// the seek path would return for that page.
		const scan = await load({ category: "news" }, { limit: 2 });
		expect(scan.entries).toHaveLength(2);
		for (const e of scan.entries) expect(titles).toContain(e.data.title as string);
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

	it("resolves a taxonomy filter by the localized term slug in the query locale (#1480)", async () => {
		// One term with an EN anchor + FR translation sharing a translation_group.
		// `content_taxonomies.taxonomy_id` stores that group (migration 036), so a
		// single tag spans both locales. The loader's EXISTS join must therefore
		// key on `t.translation_group` (not `t.id`) and scope `t.locale` to the
		// query locale — otherwise it only ever lands on the EN anchor row.
		const groupId = "tax_category_news_group";
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: groupId,
				name: "category",
				slug: "news",
				label: "News",
				locale: "en",
				translation_group: groupId,
			} as never)
			.execute();
		await termTranslation("category", "actualites", "fr", groupId);

		// A French entry tagged with the term group.
		const frPost = await createPost("Actualités", "fr");
		await tag(frPost.id, groupId);

		// FR site, FR slug → matches. Before the fix the join landed on the EN
		// anchor (slug "news"), so this returned 0.
		const hit = await load({ category: "actualites" }, { locale: "fr" });
		expect(hit.entries).toHaveLength(1);
		expect(hit.entries[0]!.data.title).toBe("Actualités");

		// FR site, EN slug → must NOT match: the `t.locale` predicate scopes the
		// slug to the active locale, where the term is "actualites", not "news".
		const miss = await load({ category: "news" }, { locale: "fr" });
		expect(miss.entries).toHaveLength(0);

		// Locale-less query still resolves the default-locale slug — the locale
		// predicate is conditional, so the no-locale path matches a tag in any
		// locale variant of the group.
		const anyLocale = await load({ category: "news" });
		expect(anyLocale.entries).toHaveLength(1);
		expect(anyLocale.entries[0]!.data.title).toBe("Actualités");
	});
});
