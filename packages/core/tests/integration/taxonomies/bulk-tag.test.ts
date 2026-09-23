import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

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
