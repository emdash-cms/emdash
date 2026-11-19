import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleSitemapData, handleSitemapIndexData } from "../../../src/api/handlers/seo.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const OLD_CONTENT_UPDATED_AT = "2024-01-01 00:00:00";
const SEO_UPDATED_AT = "2024-02-01T00:00:00.000Z";
const LATER_CONTENT_UPDATED_AT = "2024-02-01 12:00:00";

interface SitemapDates {
	entryUpdatedAt: string;
	indexLastmod: string;
}

describeEachDialect("sitemap SEO lastmod", (dialect) => {
	let ctx: DialectTestContext;
	let content: ContentRepository;
	let seo: SeoRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		content = new ContentRepository(ctx.db);
		seo = new SeoRepository(ctx.db);

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await teardownForDialect(ctx);
	});

	async function publishedPost(slug = "hello", locale = "en", translationOf?: string) {
		const post = await content.create({
			type: "post",
			slug,
			locale,
			translationOf,
			data: { title: "Hello" },
			status: "published",
		});
		await sql`UPDATE ec_post SET updated_at = ${OLD_CONTENT_UPDATED_AT} WHERE id = ${post.id}`.execute(
			ctx.db,
		);
		return post;
	}

	async function sitemapDates(): Promise<SitemapDates> {
		const data = await handleSitemapData(ctx.db, "post");
		expect(data.success).toBe(true);
		const index = await handleSitemapIndexData(ctx.db);
		expect(index.success).toBe(true);
		return {
			entryUpdatedAt: data.data!.collections[0]!.entries[0]!.updatedAt,
			indexLastmod: index.data!.sitemaps[0]!.lastmod,
		};
	}

	it("uses a live SEO title change for both sitemap dates", async () => {
		const post = await publishedPost();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(SEO_UPDATED_AT));

		await seo.upsert("post", post.id, { title: "Hello - Updated" });

		expect(await sitemapDates()).toEqual({
			entryUpdatedAt: SEO_UPDATED_AT,
			indexLastmod: SEO_UPDATED_AT,
		});
	});

	it("updates sitemap dates for runtime SEO saves without changing content updated_at", async () => {
		const post = await publishedPost();
		const runtime = createTestRuntime(ctx.db);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(SEO_UPDATED_AT));

		await runtime.handleContentUpdate("post", post.id, {
			data: { title: "Pending draft" },
			seo: { title: "Live SEO title" },
		});

		expect(await sitemapDates()).toEqual({
			entryUpdatedAt: SEO_UPDATED_AT,
			indexLastmod: SEO_UPDATED_AT,
		});
		await expect(
			ctx.db
				.selectFrom("ec_post")
				.select("updated_at")
				.where("id", "=", post.id)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({ updated_at: OLD_CONTENT_UPDATED_AT });

		const laterDate = "2024-03-01T00:00:00.000Z";
		vi.setSystemTime(new Date(laterDate));
		await runtime.handleContentUpdate("post", post.id, {
			data: { title: "Another pending draft" },
			seo: { title: "Live SEO title" },
		});

		expect(await sitemapDates()).toEqual({
			entryUpdatedAt: SEO_UPDATED_AT,
			indexLastmod: SEO_UPDATED_AT,
		});
		await expect(
			ctx.db
				.selectFrom("ec_post")
				.select("updated_at")
				.where("id", "=", post.id)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({ updated_at: OLD_CONTENT_UPDATED_AT });
	});

	it("uses a later content update instead of an older SEO update", async () => {
		const post = await publishedPost();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(SEO_UPDATED_AT));
		await seo.upsert("post", post.id, { title: "Hello - Updated" });
		await sql`UPDATE ec_post SET updated_at = ${LATER_CONTENT_UPDATED_AT} WHERE id = ${post.id}`.execute(
			ctx.db,
		);

		expect(await sitemapDates()).toEqual({
			entryUpdatedAt: "2024-02-01T12:00:00.000Z",
			indexLastmod: "2024-02-01T12:00:00.000Z",
		});
	});

	it("limits SEO modification dates to the indexable entries on each page", async () => {
		const posts = [await publishedPost("one"), await publishedPost("two")];
		posts.sort((a, b) => a.id.localeCompare(b.id));
		const hidden = await publishedPost("hidden");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(SEO_UPDATED_AT));
		await seo.upsert("post", posts[1].id, { description: "New description" });
		vi.setSystemTime(new Date("2024-03-01T00:00:00.000Z"));
		await seo.upsert("post", hidden.id, { title: "Hidden", noIndex: true });

		const result = await handleSitemapIndexData(ctx.db, 1);
		expect(result.success).toBe(true);
		expect(result.data!.sitemaps).toEqual([
			{ collection: "post", page: 1, lastmod: "2024-01-01T00:00:00.000Z" },
			{ collection: "post", page: 2, lastmod: SEO_UPDATED_AT },
		]);
	});

	it("falls back to content updated_at when no SEO row exists", async () => {
		const post = await publishedPost();

		expect(await sitemapDates()).toEqual({
			entryUpdatedAt: "2024-01-01T00:00:00.000Z",
			indexLastmod: "2024-01-01T00:00:00.000Z",
		});
		await expect(seo.get("post", post.id)).resolves.toEqual({
			title: null,
			description: null,
			image: null,
			canonical: null,
			noIndex: false,
		});
	});

	it("does not advance the lastmod for unchanged or empty SEO input", async () => {
		const post = await publishedPost();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(SEO_UPDATED_AT));
		await seo.upsert("post", post.id, { title: "Hello" });
		const afterInitialWrite = await sitemapDates();

		vi.setSystemTime(new Date("2024-03-01T00:00:00.000Z"));
		await seo.upsert("post", post.id, { title: "Hello" });
		expect(await sitemapDates()).toEqual(afterInitialWrite);

		const emptyPost = await publishedPost("empty");
		await seo.upsert("post", emptyPost.id, {});
		await seo.upsert("post", emptyPost.id, {
			title: null,
			description: null,
			image: null,
			canonical: null,
			noIndex: false,
		});
		const emptyData = await handleSitemapData(ctx.db, "post");
		expect(
			emptyData.data!.collections[0]!.entries.find((entry) => entry.id === emptyPost.id)?.updatedAt,
		).toBe("2024-01-01T00:00:00.000Z");
	});

	it("advances lastmod when an SEO title is cleared", async () => {
		const post = await publishedPost();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(SEO_UPDATED_AT));
		await seo.upsert("post", post.id, { title: "Hello - Updated" });

		const clearedAt = "2024-03-01T00:00:00.000Z";
		vi.setSystemTime(new Date(clearedAt));
		await seo.upsert("post", post.id, { title: null });

		expect(await sitemapDates()).toEqual({
			entryUpdatedAt: clearedAt,
			indexLastmod: clearedAt,
		});
	});

	it("can set and clear noIndex without losing existing SEO fields", async () => {
		const post = await publishedPost();
		await seo.upsert("post", post.id, { title: "Keep this title", noIndex: true });
		const hidden = await handleSitemapData(ctx.db, "post");
		expect(hidden.data!.collections).toEqual([]);

		expect(await seo.upsert("post", post.id, { noIndex: false })).toMatchObject({
			title: "Keep this title",
			noIndex: false,
		});
		const visible = await handleSitemapData(ctx.db, "post");
		expect(visible.data!.collections[0].entries[0].id).toBe(post.id);
	});

	it("does not use one locale sibling's SEO update for another locale", async () => {
		const en = await publishedPost("hello", "en");
		const fr = await publishedPost("bonjour", "fr", en.id);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(SEO_UPDATED_AT));
		await seo.upsert("post", en.id, { title: "Hello - Updated" });

		const data = await handleSitemapData(ctx.db, "post");
		expect(data.success).toBe(true);
		expect(data.data!.collections[0]!.entries.find((entry) => entry.id === en.id)?.updatedAt).toBe(
			SEO_UPDATED_AT,
		);
		expect(data.data!.collections[0]!.entries.find((entry) => entry.id === fr.id)?.updatedAt).toBe(
			"2024-01-01T00:00:00.000Z",
		);
	});
});
