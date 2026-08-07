import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

/**
 * Regression test for #1600: loadEntry's SELECT shape on wide collections.
 *
 * When a per-collection `ec_*` table has many flat scalar columns (common when
 * porting from WordPress / ACF or other builders where every section is a
 * top-level field), the previous implementation did:
 *
 *   SELECT c.*, <5 SEO alias columns> FROM ec_table c LEFT JOIN _emdash_seo s
 *
 * On Cloudflare D1 the per-query result-set column limit (~100) made this
 * fail with `D1_ERROR: too many columns in result set` for collections
 * around 95+ user columns. The loader's try/catch wrapped it as a generic
 * `Failed to load entry` error and the call site returned a silent `null`.
 *
 * The fix folds SEO into a single aggregated JSON column (`_emdash_seo`)
 * mirroring how byline and taxonomy hydration already work: aggregate in SQL,
 * expand in JS. One JSON column is one column, so the result-set width stays
 * bounded at any collection schema width and the single round trip is
 * preserved.
 *
 * Run on both dialects to keep parity with loader-seo.test.ts.
 */
describeEachDialect("Loader on wide-schema collections (#1600)", (dialect) => {
	let ctx: DialectTestContext;
	let seoRepo: SeoRepository;
	const COLLECTION = "wide_collection";
	const USER_FIELD_COUNT = 95;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);

		// Create a collection with SEO enabled and a large number of flat
		// scalar fields. 95 user fields + 14 system columns + 5 SEO aliases
		// would have been ~114 result-set columns under the old LEFT JOIN
		// shape, well past D1's per-query limit.
		await registry.createCollection({
			slug: COLLECTION,
			label: "Wide Collection",
			labelSingular: "Wide Entry",
		});
		await registry.createField(COLLECTION, {
			slug: "title",
			label: "Title",
			type: "string",
		});
		for (let i = 1; i <= USER_FIELD_COUNT; i++) {
			await registry.createField(COLLECTION, {
				slug: `field_${i}`,
				label: `Field ${i}`,
				type: "string",
			});
		}
		// Enable SEO so extractSeo() has somewhere to read from.
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", COLLECTION)
			.execute();

		seoRepo = new SeoRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function load(idOrSlug: string) {
		const loader = emdashLoader();
		return runWithContext({ db: ctx.db }, () =>
			loader.loadEntry!({ filter: { type: COLLECTION, id: idOrSlug } }),
		);
	}

	it("loads an entry from a collection with 95+ flat user columns", async () => {
		const data: Record<string, string> = { title: "Wide Entry" };
		for (let i = 1; i <= USER_FIELD_COUNT; i++) {
			data[`field_${i}`] = `value-${i}`;
		}
		const result = await handleContentCreate(ctx.db, COLLECTION, {
			data,
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create entry");
		const slug = result.data!.item.slug!;

		const loaded = await load(slug);

		expect(loaded).toBeDefined();
		expect((loaded as { data: Record<string, unknown> }).data.title).toBe("Wide Entry");
		// Spot-check a handful of user fields across the range.
		const loadedData = (loaded as { data: Record<string, unknown> }).data;
		expect(loadedData.field_1).toBe("value-1");
		expect(loadedData.field_50).toBe("value-50");
		expect(loadedData.field_95).toBe("value-95");
	});

	it("still attaches data.seo on wide collections (folded JSON column)", async () => {
		const data: Record<string, string> = { title: "Wide With SEO" };
		for (let i = 1; i <= USER_FIELD_COUNT; i++) {
			data[`field_${i}`] = `value-${i}`;
		}
		const result = await handleContentCreate(ctx.db, COLLECTION, {
			data,
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create entry");
		const item = result.data!.item;

		await seoRepo.upsert(COLLECTION, item.id, {
			noIndex: true,
			canonical: "https://example.com/wide",
			title: "Wide SEO Title",
		});

		const loaded = await load(item.slug!);
		const loadedData = (loaded as { data: Record<string, unknown> }).data;
		const seo = loadedData.seo as Record<string, unknown> | undefined;

		expect(seo).toBeDefined();
		expect(seo!.noIndex).toBe(true);
		expect(seo!.canonical).toBe("https://example.com/wide");
		expect(seo!.title).toBe("Wide SEO Title");
	});

	it("omits data.seo when no SEO row exists, even on wide collections", async () => {
		const data: Record<string, string> = { title: "No SEO" };
		for (let i = 1; i <= USER_FIELD_COUNT; i++) {
			data[`field_${i}`] = `value-${i}`;
		}
		const result = await handleContentCreate(ctx.db, COLLECTION, {
			data,
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create entry");
		const slug = result.data!.item.slug!;

		const loaded = await load(slug);
		const loadedData = (loaded as { data: Record<string, unknown> }).data;

		expect(loadedData.seo).toBeUndefined();
	});
});
