import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleBulkTag } from "../../../src/api/handlers/bulk-tag.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const origin = "https://blog.example.com";

describeEachDialect("bulk tag posts", (dialect) => {
	let ctx: DialectTestContext;
	let content: ContentRepository;
	let taxonomy: TaxonomyRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		content = new ContentRepository(ctx.db);
		taxonomy = new TaxonomyRepository(ctx.db);
		await ctx.db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: '["post"]' })
			.where("name", "=", "tag")
			.execute();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownForDialect(ctx);
	});

	it("previews selected posts, adds without replacing tags, and skips repeat requests", async () => {
		const existing = await taxonomy.create({ name: "tag", slug: "existing", label: "Existing" });
		const intern = await taxonomy.create({
			name: "tag",
			slug: "intern",
			label: "Internship Experience",
		});
		const post = await content.create({ type: "post", slug: "a-post", data: { title: "A post" } });
		await taxonomy.attachToEntry("post", post.id, existing.id);
		const input = { termId: intern.id, apply: false, items: [{ collection: "post", id: post.id }] };

		const preview = await handleBulkTag(ctx.db, origin, input);
		expect(preview.success && preview.data.results).toMatchObject([
			{ status: "ready", entry: { title: "A post", locale: "en" } },
		]);
		expect(
			(await taxonomy.getTermsForEntry("post", post.id, "tag")).map((term) => term.slug),
		).toEqual(["existing"]);

		const applied = await handleBulkTag(ctx.db, origin, { ...input, apply: true });
		expect(applied.success && applied.data.results[0]?.status).toBe("added");
		expect(
			(await taxonomy.getTermsForEntry("post", post.id, "tag")).map((term) => term.slug).toSorted(),
		).toEqual(["existing", "intern"]);
		const repeat = await handleBulkTag(ctx.db, origin, { ...input, apply: true });
		expect(repeat.success && repeat.data.results[0]?.status).toBe("skipped");
	});

	it("matches only canonical published URLs on this origin, including date and locale", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ url_pattern: "/blog/{year}/{month}/{slug}" })
			.where("slug", "=", "post")
			.execute();
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const en = await content.create({
			type: "post",
			slug: "example",
			data: { title: "Example" },
			locale: "en",
		});
		const fr = await content.create({
			type: "post",
			slug: "exemple",
			data: { title: "Exemple" },
			locale: "fr",
			translationOf: en.id,
		});
		await content.publish("post", en.id, "2026-09-15T00:00:00.000Z");
		await content.publish("post", fr.id, "2026-09-15T00:00:00.000Z");
		const urls = [
			`${origin}/fr/blog/2026/09/exemple`,
			`${origin}/blog/2025/09/example`,
			"https://elsewhere.example/blog/2026/09/example",
			`${origin}/blog/2026/09/unknown`,
		];
		const input = { termId: intern.id, apply: true, items: urls.map((url) => ({ url })) };
		const result = await handleBulkTag(ctx.db, origin, input);
		expect(result.success && result.data.results.map((item) => item.status)).toEqual([
			"added",
			"unmatched",
			"unmatched",
			"unmatched",
		]);
		expect(result.success && result.data.results[0]?.entry).toMatchObject({
			title: "Exemple",
			locale: "fr",
		});
		expect(
			(await taxonomy.getTermsForEntry("post", en.id, "tag")).map((term) => term.slug),
		).toEqual(["intern"]);
	});

	it("does not match an archived post through its former public URL", async () => {
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const post = await content.create({
			type: "post",
			slug: "retired",
			data: { title: "Retired" },
		});
		await content.publish("post", post.id);
		await ctx.db
			.updateTable("ec_post")
			.set({ status: "archived" })
			.where("id", "=", post.id)
			.execute();
		const result = await handleBulkTag(ctx.db, origin, {
			termId: intern.id,
			apply: true,
			items: [{ url: `${origin}/post/retired` }],
		});
		expect(result.success && result.data.results).toMatchObject([{ status: "unmatched" }]);
		expect(await taxonomy.getTermsForEntry("post", post.id, "tag")).toEqual([]);
	});

	it("applies to the reviewed ID when its former URL now belongs to another post", async () => {
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const original = await content.create({
			type: "post",
			slug: "old",
			data: { title: "Original" },
		});
		await content.publish("post", original.id);
		const review = await handleBulkTag(ctx.db, origin, {
			termId: intern.id,
			apply: false,
			items: [{ url: `${origin}/post/old` }],
		});
		expect(review.success && review.data.results[0]?.entry?.id).toBe(original.id);
		await ctx.db
			.updateTable("ec_post")
			.set({ slug: "renamed" })
			.where("id", "=", original.id)
			.execute();
		const replacement = await content.create({
			type: "post",
			slug: "old",
			data: { title: "Replacement" },
		});
		await content.publish("post", replacement.id);
		if (!review.success || !review.data.results[0]?.entry)
			throw new Error("Preview missing original post");
		const { collection, id } = review.data.results[0].entry;
		const applied = await handleBulkTag(ctx.db, origin, {
			termId: intern.id,
			apply: true,
			items: [{ collection, id }],
		});
		expect(applied.success && applied.data.results[0]?.entry?.id).toBe(original.id);
		expect(
			(await taxonomy.getTermsForEntry("post", original.id, "tag")).map((term) => term.slug),
		).toEqual(["intern"]);
		expect(await taxonomy.getTermsForEntry("post", replacement.id, "tag")).toEqual([]);
	});

	it("bounds database round trips for a fifteen-post URL backfill", async () => {
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const posts = [];
		for (let index = 0; index < 15; index++) {
			const post = await content.create({
				type: "post",
				slug: `intern-${index}`,
				data: { title: `Intern ${index}` },
			});
			await content.publish("post", post.id);
			posts.push(post);
		}
		let queries = 0;
		const countedDb = ctx.db.withPlugin({
			transformQuery(args) {
				queries++;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		const preview = await handleBulkTag(countedDb, origin, {
			termId: intern.id,
			apply: false,
			items: posts.map((post) => ({ url: `${origin}/post/${post.slug}` })),
		});
		if (!preview.success) throw new Error(preview.error.message);
		expect(preview.data.results.every((result) => result.status === "ready")).toBe(true);
		const applied = await handleBulkTag(
			countedDb,
			origin,
			{
				termId: intern.id,
				apply: true,
				items: preview.data.results.map((result) => ({
					collection: result.entry!.collection,
					id: result.entry!.id,
				})),
			},
			async () => undefined,
		);
		expect(
			applied.success && applied.data.results.every((result) => result.status === "added"),
		).toBe(true);
		expect(queries).toBeLessThan(60);
	});

	it("fails before writing if cache metadata cannot be read", async () => {
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const post = await content.create({ type: "post", slug: "hello", data: { title: "Hello" } });
		vi.spyOn(ContentRepository.prototype, "findTranslationIdsForGroups").mockRejectedValueOnce(
			new Error("metadata unavailable"),
		);
		const result = await handleBulkTag(
			ctx.db,
			origin,
			{
				termId: intern.id,
				apply: true,
				items: [{ collection: "post", id: post.id }],
			},
			async () => undefined,
		);
		expect(result.success).toBe(false);
		expect(await taxonomy.getTermsForEntry("post", post.id, "tag")).toEqual([]);
	});

	it("reports committed assignments separately from a cache purge failure and permits retry", async () => {
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const post = await content.create({ type: "post", slug: "hello", data: { title: "Hello" } });
		const input = { termId: intern.id, apply: true, items: [{ collection: "post", id: post.id }] };
		const first = await handleBulkTag(ctx.db, origin, input, async () => {
			throw new Error("cache unavailable");
		});
		expect(first.success && first.data).toMatchObject({
			results: [{ status: "added" }],
			cacheRefreshFailed: true,
		});
		expect(
			(await taxonomy.getTermsForEntry("post", post.id, "tag")).map((term) => term.slug),
		).toEqual(["intern"]);
		const purged: string[][] = [];
		const retry = await handleBulkTag(ctx.db, origin, input, async (tags) => {
			purged.push(tags);
		});
		expect(retry.success && retry.data).toMatchObject({
			results: [{ status: "skipped" }],
			cacheRefreshFailed: false,
		});
		expect(purged.flat()).toEqual(expect.arrayContaining([post.id, "emdash:taxonomy:tag"]));
	});

	it("deduplicates translated siblings and purges both entry caches", async () => {
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		await taxonomy.create({
			name: "tag",
			slug: "stagiaire",
			label: "Stagiaire",
			locale: "fr",
			translationOf: intern.id,
		});
		const en = await content.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			locale: "en",
		});
		const fr = await content.create({
			type: "post",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: en.id,
		});
		const purged: string[][] = [];
		const result = await handleBulkTag(
			ctx.db,
			origin,
			{
				termId: intern.id,
				apply: true,
				items: [
					{ collection: "post", id: en.id },
					{ collection: "post", id: fr.id },
				],
			},
			async (tags) => {
				purged.push(tags);
			},
		);
		expect(result.success && result.data.results.map((item) => item.status)).toEqual([
			"added",
			"skipped",
		]);
		expect(purged.flat()).toEqual(
			expect.arrayContaining(["post", en.id, fr.id, "emdash:taxonomy:tag"]),
		);
		expect(
			(await taxonomy.getTermsForEntry("post", fr.id, "tag", "fr")).map((term) => term.slug),
		).toEqual(["stagiaire"]);
	});

	it("does not tag missing or disallowed posts, but continues with valid ones", async () => {
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const post = await content.create({ type: "post", slug: "hello", data: { title: "Hello" } });
		const page = await content.create({ type: "page", slug: "hello", data: { title: "A page" } });
		const result = await handleBulkTag(ctx.db, origin, {
			termId: intern.id,
			apply: true,
			items: [
				{ collection: "page", id: page.id },
				{ collection: "post", id: "missing" },
				{ collection: "post", id: post.id },
			],
		});
		expect(result.success && result.data.results.map((item) => item.status)).toEqual([
			"unmatched",
			"unmatched",
			"added",
		]);
	});

	it("flags a URL shared by two collections instead of choosing one", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "articles",
			label: "Articles",
			urlPattern: "/blog/{slug}",
		});
		await registry.createField("articles", { slug: "title", label: "Title", type: "string" });
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ url_pattern: "/blog/{slug}" })
			.where("slug", "=", "post")
			.execute();
		await ctx.db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: '["post","articles"]' })
			.where("name", "=", "tag")
			.execute();
		const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
		const post = await content.create({ type: "post", slug: "same", data: { title: "A post" } });
		const article = await content.create({
			type: "articles",
			slug: "same",
			data: { title: "An article" },
		});
		await content.publish("post", post.id);
		await content.publish("articles", article.id);
		const result = await handleBulkTag(ctx.db, origin, {
			termId: intern.id,
			apply: true,
			items: [{ url: `${origin}/blog/same` }],
		});
		expect(result.success && result.data.results).toMatchObject([
			{ status: "unmatched", reason: "ambiguous" },
		]);
		expect(await taxonomy.getTermsForEntry("post", post.id, "tag")).toEqual([]);
		expect(await taxonomy.getTermsForEntry("articles", article.id, "tag")).toEqual([]);
	});

	if (dialect === "sqlite") {
		it("refreshes cache without attempting an idempotent write that now fails", async () => {
			const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
			const post = await content.create({ type: "post", slug: "hello", data: { title: "Hello" } });
			const input = {
				termId: intern.id,
				apply: true,
				items: [{ collection: "post", id: post.id }],
			};
			const first = await handleBulkTag(ctx.db, origin, input, async () => {
				throw new Error("cache unavailable");
			});
			expect(first.success && first.data.cacheRefreshFailed).toBe(true);
			await sql`CREATE TRIGGER block_repeat_tag BEFORE INSERT ON content_taxonomies
				BEGIN SELECT RAISE(ABORT, 'write blocked'); END`.execute(ctx.db);
			const purged: string[][] = [];
			const retry = await handleBulkTag(
				ctx.db,
				origin,
				{ ...input, refreshOnly: true },
				async (tags) => {
					purged.push(tags);
				},
			);
			expect(retry.success && retry.data).toMatchObject({
				results: [{ status: "skipped" }],
				cacheRefreshFailed: false,
			});
			expect(purged.flat()).toEqual(expect.arrayContaining([post.id, "emdash:taxonomy:tag"]));
		});

		it("reports a failed write without stopping other posts, then retries only that post", async () => {
			const intern = await taxonomy.create({ name: "tag", slug: "intern", label: "Intern" });
			const first = await content.create({ type: "post", slug: "first", data: { title: "First" } });
			const blocked = await content.create({
				type: "post",
				slug: "blocked",
				data: { title: "Blocked" },
			});
			const last = await content.create({ type: "post", slug: "last", data: { title: "Last" } });
			await sql`CREATE TRIGGER block_tag_insert BEFORE INSERT ON content_taxonomies
				WHEN NEW.entry_id = (SELECT translation_group FROM ec_post WHERE slug = 'blocked')
				BEGIN SELECT RAISE(ABORT, 'write failed'); END`.execute(ctx.db);
			const items = [first, blocked, last].map((item) => ({ collection: "post", id: item.id }));
			const result = await handleBulkTag(ctx.db, origin, { termId: intern.id, apply: true, items });
			expect(result.success && result.data.results.map((item) => item.status)).toEqual([
				"added",
				"failed",
				"added",
			]);
			await sql`DROP TRIGGER block_tag_insert`.execute(ctx.db);
			const retry = await handleBulkTag(ctx.db, origin, {
				termId: intern.id,
				apply: true,
				items: [items[1]!],
			});
			expect(retry.success && retry.data.results[0]?.status).toBe("added");
			expect(
				(await taxonomy.getTermsForEntry("post", blocked.id, "tag")).map((term) => term.slug),
			).toEqual(["intern"]);
		});
	}
});
