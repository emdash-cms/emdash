import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleSitemapData, handleSitemapIndexData } from "../../../src/api/handlers/seo.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("sitemap pagination", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new ContentRepository(ctx.db);
		await new SchemaRegistry(ctx.db).createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("splits a collection into pages ordered by ID", async () => {
		const ids: string[] = [];
		for (const slug of ["one", "two", "three"]) {
			const item = await repo.create({ type: "post", slug, data: {}, status: "published" });
			ids.push(item.id);
		}
		ids.sort();

		const pageIds = async (page: number) => {
			const result = await handleSitemapData(ctx.db, "post", { page, pageSize: 2 });
			expect(result.success).toBe(true);
			return result.data!.collections.flatMap((c) => c.entries.map((e) => e.id));
		};

		expect(await pageIds(1)).toEqual(ids.slice(0, 2));
		expect(await pageIds(2)).toEqual(ids.slice(2));
		expect(await pageIds(3)).toEqual([]);
	});

	it("returns translations that sit on another page", async () => {
		const en = await repo.create({
			type: "post",
			slug: "hello",
			data: {},
			status: "published",
			locale: "en",
		});
		const fr = await repo.create({
			type: "post",
			slug: "bonjour",
			data: {},
			status: "published",
			locale: "fr",
			translationOf: en.id,
		});
		const [first, second] = [en.id, fr.id].toSorted();

		for (const [page, onPage, sibling] of [
			[1, first, second],
			[2, second, first],
		] as const) {
			const result = await handleSitemapData(ctx.db, "post", { page, pageSize: 1 });
			const col = result.data!.collections[0]!;
			expect(col.entries.map((e) => e.id)).toEqual([onPage]);
			expect(col.translations.map((e) => e.id)).toEqual([sibling]);
		}
	});

	it("lists one index entry per page with that page's latest update", async () => {
		const items = [];
		for (const slug of ["one", "two", "three"]) {
			items.push(await repo.create({ type: "post", slug, data: {}, status: "published" }));
		}
		const hidden = await repo.create({
			type: "post",
			slug: "hidden",
			data: {},
			status: "published",
		});
		await new SeoRepository(ctx.db).upsert("post", hidden.id, { noIndex: true });

		const sorted = items.toSorted((a, b) => (a.id < b.id ? -1 : 1));
		const stamps = ["2026-01-01 00:00:00", "2026-03-01 00:00:00", "2026-02-01 00:00:00"];
		for (const [i, item] of sorted.entries()) {
			await sql`UPDATE ec_post SET updated_at = ${stamps[i]} WHERE id = ${item.id}`.execute(ctx.db);
		}

		const result = await handleSitemapIndexData(ctx.db, 2);

		expect(result.success).toBe(true);
		expect(result.data!.sitemaps).toEqual([
			{ collection: "post", page: 1, lastmod: "2026-03-01T00:00:00.000Z" },
			{ collection: "post", page: 2, lastmod: "2026-02-01T00:00:00.000Z" },
		]);
	});
});
