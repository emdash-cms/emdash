import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { findLivePermalinkSources } from "../../../src/import/wxr-permalink-routes.js";
import { importWxrPermalinks, type WxrPermalinkEntry } from "../../../src/import/wxr-permalinks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const pattern = "/{year}/{month}/{day}/{slug}";

describeEachDialect("WordPress permalink preservation", (dialect) => {
	let ctx: DialectTestContext;
	let nextId = 0;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownForDialect(ctx);
	});

	function post(
		options: {
			id?: string;
			slug?: string;
			status?: string;
			date?: string | null;
			locale?: string;
		} = {},
	) {
		return {
			id: options.id ?? `post-${++nextId}`,
			slug: options.slug ?? "example-post",
			status: options.status ?? "published",
			publishedAt: options.date === undefined ? "2004-05-02T00:00:00.000Z" : options.date,
			locale: options.locale ?? "en",
		};
	}

	function entry(
		link: string,
		item: ReturnType<typeof post> = post(),
		options: Partial<WxrPermalinkEntry> = {},
	): WxrPermalinkEntry {
		return {
			title: item.slug,
			link,
			collection: "posts",
			pattern,
			item,
			...options,
		};
	}

	async function redirects() {
		return (
			await ctx.db
				.selectFrom("_emdash_redirects")
				.select(["source", "destination", "type", "enabled", "is_pattern"])
				.execute()
		).map((row) => ({
			source: row.source,
			destination: row.destination,
			type: Number(row.type),
			enabled: Number(row.enabled),
			isPattern: Number(row.is_pattern),
		}));
	}

	it("creates a 301 from the original WordPress pathname to the canonical date URL", async () => {
		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/"),
		]);
		expect(result).toEqual([]);
		expect(await redirects()).toEqual([
			{
				source: "/2004/05/01/example-post",
				destination: "/2004/05/02/example-post",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it.each([false, true])(
		"refuses a source assigned to an entry by the same import (reverse=%s)",
		async (reverse) => {
			const entries = [
				entry("https://wp.test/old-first/", post({ id: "first", slug: "claimed" }), {
					pattern: "/{slug}",
				}),
				entry("https://wp.test/claimed/", post({ id: "second", slug: "second" }), {
					pattern: "/{slug}",
				}),
			];
			const errors = await importWxrPermalinks(ctx.db, reverse ? entries.toReversed() : entries);
			expect(errors).toEqual([
				{
					title: "second",
					error:
						"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
				},
			]);
			expect(await redirects()).toEqual([
				{ source: "/old-first", destination: "/claimed", type: 301, enabled: 1, isPattern: 0 },
			]);
		},
	);

	it("updates an owned redirect when only the trailing slash changes", async () => {
		const first = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/", post(), { trailingSlash: "always" }),
		]);
		expect(first).toEqual([]);
		expect(await redirects()).toEqual([
			{
				source: "/2004/05/01/example-post",
				destination: "/2004/05/02/example-post/",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);

		const second = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/", post(), { trailingSlash: "never" }),
		]);
		expect(second).toEqual([]);
		expect(await redirects()).toEqual([
			{
				source: "/2004/05/01/example-post",
				destination: "/2004/05/02/example-post",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it("normalizes an existing importer redirect source on rerun", async () => {
		const repo = new RedirectRepository(ctx.db);
		const rule = await repo.create({
			source: "/old/",
			destination: "/canonical",
			type: 301,
			enabled: true,
			auto: true,
			groupName: "WordPress import",
		});

		expect(
			await importWxrPermalinks(ctx.db, [
				entry("https://wp.test/old/", post({ id: "canonical", slug: "canonical" }), {
					pattern: "/{slug}",
				}),
			]),
		).toEqual([]);
		expect(
			await ctx.db
				.selectFrom("_emdash_redirects")
				.select(["id", "source", "destination", "type"])
				.execute(),
		).toEqual([{ id: rule.id, source: "/old", destination: "/canonical", type: 301 }]);
	});

	it("is idempotent and leaves a same-day trailing-slash difference alone", async () => {
		const first = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/"),
		]);
		const second = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/"),
		]);
		const sameDay = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/02/example-post/"),
		]);
		expect(first).toEqual([]);
		expect(second).toEqual([]);
		expect(sameDay).toEqual([]);
		expect((await redirects()).length).toBe(1);
	});

	it("preserves disabled importer rules even when their source becomes canonical", async () => {
		const repo = new RedirectRepository(ctx.db);
		const rule = await repo.create({
			source: "/2004/05/02/example-post/",
			destination: "/blog/example-post",
			enabled: false,
			auto: true,
			groupName: "WordPress import",
		});
		expect(
			await importWxrPermalinks(ctx.db, [entry("https://wp.test/2004/05/02/example-post/")]),
		).toEqual([]);
		expect(await repo.findById(rule.id)).toEqual(rule);
	});

	it("does not decode an existing exact redirect destination twice while checking loops", async () => {
		const manual = await new RedirectRepository(ctx.db).create({
			source: "/target",
			destination: "/literal%2541",
			type: 301,
			enabled: true,
			auto: false,
		});

		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/literalA/", post({ id: "target", slug: "target" }), {
				pattern: "/{slug}",
			}),
		]);

		expect(result).toEqual([]);
		expect(await new RedirectRepository(ctx.db).findById(manual.id)).toMatchObject({
			source: "/target",
			destination: "/literal%2541",
		});
		expect(await redirects()).toEqual([
			{
				source: "/target",
				destination: "/literal%2541",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
			{
				source: "/literalA",
				destination: "/target",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it("reports a loop when the imported source is an existing exact destination", async () => {
		await new RedirectRepository(ctx.db).create({
			source: "/target",
			destination: "/literal%2541",
			type: 301,
			enabled: true,
			auto: false,
		});

		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/literal%2541/", post({ id: "target", slug: "target" }), {
				pattern: "/{slug}",
			}),
		]);

		expect(result).toEqual([
			{
				title: "target",
				error: "Could not create redirect: the WordPress permalink would create a redirect loop",
			},
		]);
		expect(await redirects()).toEqual([
			{
				source: "/target",
				destination: "/literal%2541",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it("rejects a redirect that would loop through an existing pattern", async () => {
		await ctx.db
			.insertInto("_emdash_redirects")
			.values({
				id: "pattern-loop",
				source: "/2004/05/02/[slug]",
				destination: "/2004/05/01/[slug]",
				type: 301,
				is_pattern: 1,
				hits: 0,
				enabled: 1,
				auto: 0,
				created_at: "2024-01-01",
				updated_at: "2024-01-01",
			})
			.execute();

		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/"),
		]);

		expect(result).toEqual([
			{
				title: "example-post",
				error: "Could not create redirect: the WordPress permalink would create a redirect loop",
			},
		]);
		expect(await redirects()).toEqual([
			{
				source: "/2004/05/02/[slug]",
				destination: "/2004/05/01/[slug]",
				type: 301,
				enabled: 1,
				isPattern: 1,
			},
		]);
	});

	it("reports slash-alias rule collisions without failing other redirects in the chunk", async () => {
		const repo = new RedirectRepository(ctx.db);
		const manual = await repo.create({ source: "/old", destination: "/manual", type: 302 });
		const owned = await repo.create({
			source: "/old/",
			destination: "/prior",
			auto: true,
			groupName: "WordPress import",
		});
		const errors = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/old/"),
			entry("https://wp.test/another/", post({ id: "other", slug: "other" })),
		]);
		expect(errors).toEqual([
			{
				title: "example-post",
				error: "Could not create redirect: an existing rule already uses the WordPress permalink",
			},
		]);
		expect(await repo.findById(manual.id)).toEqual(manual);
		expect(await repo.findById(owned.id)).toEqual(owned);
		expect((await repo.findBySource("/another"))?.destination).toBe("/2004/05/02/other");
	});

	it("preserves an owned enabled non-301 rule as a conflict", async () => {
		const repo = new RedirectRepository(ctx.db);
		const rule = await repo.create({
			source: "/2004/05/01/example-post/",
			destination: "/existing-target",
			type: 302,
			enabled: true,
			auto: true,
			groupName: "WordPress import",
		});
		const before = await ctx.db
			.selectFrom("_emdash_redirects")
			.select(["source", "destination", "type", "enabled", "is_pattern", "config_revision"])
			.where("id", "=", rule.id)
			.executeTakeFirstOrThrow();
		const expected = {
			title: "example-post",
			error: "Could not create redirect: an existing rule already uses the WordPress permalink",
		};

		expect(
			await importWxrPermalinks(ctx.db, [entry("https://wp.test/2004/05/01/example-post/")]),
		).toEqual([expected]);
		expect(
			await importWxrPermalinks(ctx.db, [entry("https://wp.test/2004/05/01/example-post/")]),
		).toEqual([expected]);
		expect(
			await ctx.db
				.selectFrom("_emdash_redirects")
				.select(["source", "destination", "type", "enabled", "is_pattern", "config_revision"])
				.where("id", "=", rule.id)
				.executeTakeFirstOrThrow(),
		).toEqual(before);
	});

	it("preserves manual, disabled, and pattern conflicts including encoded Unicode sources", async () => {
		const item = post({ slug: "café", id: "unicode" });
		await ctx.db
			.insertInto("_emdash_redirects")
			.values([
				{
					id: "manual",
					source: "/2004/05/01/caf%C3%A9/",
					destination: "/manual",
					type: 302,
					is_pattern: 0,
					enabled: 1,
					hits: 0,
					auto: 0,
					created_at: "2024-01-01",
					updated_at: "2024-01-01",
				},
				{
					id: "disabled",
					source: "/2004/05/01/other/",
					destination: "/disabled",
					type: 301,
					is_pattern: 0,
					enabled: 0,
					hits: 0,
					auto: 0,
					created_at: "2024-01-01",
					updated_at: "2024-01-01",
				},
				{
					id: "pattern",
					source: "/2004/05/01/pattern/",
					destination: "/pattern-target",
					type: 301,
					is_pattern: 1,
					enabled: 1,
					hits: 0,
					auto: 0,
					created_at: "2024-01-01",
					updated_at: "2024-01-01",
				},
			])
			.execute();
		const results = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/caf%C3%A9/", item),
			entry("https://wp.test/2004/05/01/other/"),
			entry("https://wp.test/2004/05/01/pattern/"),
		]);
		expect(results).toEqual([
			{
				title: "café",
				error: "Could not create redirect: an existing rule already uses the WordPress permalink",
			},
			{
				title: "example-post",
				error: "Could not create redirect: an existing rule already uses the WordPress permalink",
			},
			{
				title: "example-post",
				error: "Could not create redirect: an existing rule already uses the WordPress permalink",
			},
		]);
		expect(await redirects()).toEqual([
			{
				source: "/2004/05/01/caf%C3%A9/",
				destination: "/manual",
				type: 302,
				enabled: 1,
				isPattern: 0,
			},
			{
				source: "/2004/05/01/other/",
				destination: "/disabled",
				type: 301,
				enabled: 0,
				isPattern: 0,
			},
			{
				source: "/2004/05/01/pattern/",
				destination: "/pattern-target",
				type: 301,
				enabled: 1,
				isPattern: 1,
			},
		]);
	});

	it("does not treat a doubly encoded source as a loop with its canonical destination", async () => {
		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/literal%2541/", post({ id: "literal-a", slug: "literalA" }), {
				pattern: "/{slug}",
			}),
		]);
		expect(result).toEqual([]);
		expect(await redirects()).toEqual([
			{
				source: "/literal%2541",
				destination: "/literalA",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it("removes an encoded importer source when a newly imported entry claims it canonically", async () => {
		expect(
			await importWxrPermalinks(ctx.db, [
				entry("https://wp.test/literal%2541/", post({ id: "prior", slug: "prior" }), {
					pattern: "/{slug}",
				}),
			]),
		).toEqual([]);
		expect(await redirects()).toEqual([
			{
				source: "/literal%2541",
				destination: "/prior",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);

		expect(
			await importWxrPermalinks(ctx.db, [
				entry("https://wp.test/literal%2541/", post({ id: "canonical", slug: "literal%41" }), {
					pattern: "/{slug}",
				}),
			]),
		).toEqual([]);
		expect(await redirects()).toEqual([]);
	});

	it("rejects loops, invalid links, and unresolved dates without writing redirects", async () => {
		await ctx.db
			.insertInto("_emdash_redirects")
			.values({
				id: "loop",
				source: "/2004/05/02/example-post/",
				destination: "/2004/05/01/example-post",
				type: 301,
				is_pattern: 0,
				enabled: 1,
				hits: 0,
				auto: 0,
				created_at: "2024-01-01",
				updated_at: "2024-01-01",
			})
			.execute();
		const missingDate = post({ id: "missing", date: null });
		const results = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/"),
			entry("https://wp.test/2004/05/01/example-post/", missingDate),
			entry("https://wp.test/2004/05/01/example-post/?x=1"),
			entry("https://wp.test/2004/05/01/example-post/#section"),
			entry("ftp://wp.test/2004/05/01/example-post/"),
			entry("not a URL"),
		]);
		expect(results).toHaveLength(4);
		expect(await redirects()).toEqual([
			{
				source: "/2004/05/02/example-post/",
				destination: "/2004/05/01/example-post",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it("skips unpublished rows and localizes the canonical target", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		const french = post({ id: "fr", locale: "fr" });
		const unpublished = post({ id: "draft", status: "draft" });
		await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/fr/example-post/", french),
			entry("https://wp.test/2004/05/01/draft/", unpublished),
		]);
		expect(await redirects()).toEqual([
			{
				source: "/2004/05/01/fr/example-post",
				destination: "/fr/2004/05/02/example-post",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it("finds a published route owned by content outside the import batch", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", urlPattern: "/{slug}/" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await new ContentRepository(ctx.db).create({
			type: "pages",
			slug: "hello",
			status: "published",
			publishedAt: "2024-01-01T00:00:00.000Z",
			data: { title: "Hello" },
		});

		expect(await findLivePermalinkSources(ctx.db, ["/hello/", "/other/"])).toEqual(
			new Set(["/hello"]),
		);

		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/hello/", post({ id: "hello", slug: "hello" }), {
				collection: "pages",
				pattern: "/blog/{slug}",
			}),
		]);
		expect(result).toEqual([
			{
				title: "hello",
				error:
					"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
			},
		]);
		expect(await redirects()).toEqual([]);
	});

	it("preserves the base URL in imported permalink paths", async () => {
		vi.stubEnv("BASE_URL", "/archive/");
		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/archive/2004/05/01/example-post/"),
			entry("https://wp.test/2004/05/01/other-post/", post({ id: "other", slug: "other-post" })),
		]);
		expect(result).toEqual([]);
		expect(await redirects()).toEqual([
			{
				source: "/archive/2004/05/01/example-post",
				destination: "/archive/2004/05/02/example-post",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
			{
				source: "/2004/05/01/other-post",
				destination: "/archive/2004/05/02/other-post",
				type: 301,
				enabled: 1,
				isPattern: 0,
			},
		]);
	});

	it("reports an unknown locale instead of creating an unreachable redirect", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		const item = post({ locale: "de" });
		const result = await importWxrPermalinks(ctx.db, [
			entry("https://wp.test/2004/05/01/example-post/", item),
		]);
		expect(result).toHaveLength(1);
		expect(await redirects()).toEqual([]);
	});
});
