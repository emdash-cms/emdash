import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

/**
 * Regression test for #1270: SEO fields (noindex toggle, canonical URL) set in
 * the admin had no effect on rendered pages because the content loader never
 * surfaced the `_emdash_seo` row. The loader now LEFT JOINs that table and
 * attaches the result to `entry.data.seo`, which `getSeoMeta()` reads.
 *
 * Run on both dialects — the LEFT JOIN SQL is dialect-sensitive.
 */
describeEachDialect("Loader SEO hydration (#1270)", (dialect) => {
	let ctx: DialectTestContext;
	let seoRepo: SeoRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		seoRepo = new SeoRepository(ctx.db);
		// Enable SEO on the `post` collection (page stays without SEO).
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPublishedPost(title: string) {
		const result = await handleContentCreate(ctx.db, "post", {
			data: { title },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	function load(idOrSlug: string) {
		const loader = emdashLoader();
		return runWithContext({ db: ctx.db }, () =>
			loader.loadEntry!({ filter: { type: "post", id: idOrSlug } }),
		);
	}

	it("attaches noindex + canonical from _emdash_seo to entry.data.seo", async () => {
		const post = await createPublishedPost("Hidden Post");
		await seoRepo.upsert("post", post.id, {
			noIndex: true,
			canonical: "https://example.com/canonical",
			title: "SEO Title",
		});

		const result = await load(post.slug!);
		const data = (result as { data: Record<string, unknown> }).data;
		const seo = data.seo as Record<string, unknown>;

		expect(seo).toBeDefined();
		expect(seo.noIndex).toBe(true);
		expect(seo.canonical).toBe("https://example.com/canonical");
		expect(seo.title).toBe("SEO Title");
	});

	it("does not attach data.seo when no SEO row exists", async () => {
		const post = await createPublishedPost("Plain Post");

		const result = await load(post.slug!);
		const data = (result as { data: Record<string, unknown> }).data;

		expect(data.seo).toBeUndefined();
	});

	it("reflects noIndex=false as a present-but-false seo object once a row exists", async () => {
		const post = await createPublishedPost("Indexed Post");
		// A row exists (e.g. only a canonical was set), noIndex defaults false.
		await seoRepo.upsert("post", post.id, { canonical: "https://example.com/x" });

		const result = await load(post.slug!);
		const data = (result as { data: Record<string, unknown> }).data;
		const seo = data.seo as Record<string, unknown>;

		expect(seo).toBeDefined();
		expect(seo.noIndex).toBe(false);
		expect(seo.canonical).toBe("https://example.com/x");
	});

	it("does not leak raw seo_* columns as flat data fields", async () => {
		const post = await createPublishedPost("No Leak");
		await seoRepo.upsert("post", post.id, { noIndex: true });

		const result = await load(post.slug!);
		const data = (result as { data: Record<string, unknown> }).data;

		expect(data.seo_no_index).toBeUndefined();
		expect(data.seo_title).toBeUndefined();
		expect(data.seo_canonical).toBeUndefined();
	});
});
