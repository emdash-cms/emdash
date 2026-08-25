import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader, resetTaxonomyNamesCache } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
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
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["post"]) })
			.where("name", "in", ["category", "tag"])
			.execute();
		resetTaxonomyNamesCache();
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
		// Attach through the repository so the pivot row is stamped with the
		// entry's denormalized filter/sort columns (migration 051) — the state the
		// backfill and write-path re-stamp guarantee in production. The
		// pivot-drive listing seeks on those columns.
		await new TaxonomyRepository(db).attachToEntry("post", contentId, taxonomyId);
	}

	function load(where: Record<string, unknown>, locale?: string) {
		const loader = emdashLoader();
		return runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: where as never, ...(locale ? { locale } : {}) },
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

	it("filters by a taxonomy attached to the queried collection", async () => {
		const news = await term("category", "news");
		const a = await createPost("In News");
		await createPost("Untagged");
		await tag(a.id, news);

		const result = await load({ category: "news" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("In News");
	});

	it("treats a taxonomy name attached to another collection as an ordinary field", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createField("page", {
			slug: "category",
			label: "Category",
			type: "string",
		});
		const matching = await handleContentCreate(db, "page", {
			data: { title: "News Page", category: "news" },
			status: "published",
		});
		if (!matching.success) throw new Error("Failed to create page");
		const other = await handleContentCreate(db, "page", {
			data: { title: "Other Page", category: "other" },
			status: "published",
		});
		if (!other.success) throw new Error("Failed to create page");

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "page", where: { category: "news" } },
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("News Page");
	});

	it("surfaces an unexpected definition-query failure without poisoning the cache", async () => {
		const news = await term("category", "news");
		const post = await createPost("In News");
		await tag(post.id, news);

		let failNextQuery = true;
		const flakyDb = db.withPlugin({
			transformQuery(args) {
				if (failNextQuery) {
					failNextQuery = false;
					throw new Error("temporary database outage");
				}
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		const loader = emdashLoader();
		const loadWithFlakyDb = () =>
			runWithContext({ editMode: false, db: flakyDb }, () =>
				loader.loadCollection!({
					filter: { type: "post", where: { category: "news" } },
				}),
			);

		const failed = await loadWithFlakyDb();
		expect(failed).toMatchObject({
			error: { message: "Failed to load collection: temporary database outage" },
		});
		const recovered = await loadWithFlakyDb();

		expect(recovered.entries).toHaveLength(1);
		expect(recovered.entries[0]!.data.title).toBe("In News");
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
		const hit = await load({ category: "actualites" }, "fr");
		expect(hit.entries).toHaveLength(1);
		expect(hit.entries[0]!.data.title).toBe("Actualités");

		// FR site, EN slug → must NOT match: the `t.locale` predicate scopes the
		// slug to the active locale, where the term is "actualites", not "news".
		const miss = await load({ category: "news" }, "fr");
		expect(miss.entries).toHaveLength(0);

		// Locale-less query still resolves the default-locale slug — the locale
		// predicate is conditional, so the no-locale path matches a tag in any
		// locale variant of the group.
		const anyLocale = await load({ category: "news" });
		expect(anyLocale.entries).toHaveLength(1);
		expect(anyLocale.entries[0]!.data.title).toBe("Actualités");
	});
});
