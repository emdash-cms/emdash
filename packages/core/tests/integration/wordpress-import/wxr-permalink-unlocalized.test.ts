import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { importWxrPermalinks } from "../../../src/import/wxr-permalinks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("WordPress permalink route matching without i18n", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownForDialect(ctx);
	});

	it("checks every published locale for an unlocalized slug route", async () => {
		const pattern = "/{year}/{month}/{day}/{slug}";
		await new SchemaRegistry(ctx.db).createCollection({
			slug: "posts",
			label: "Posts",
			urlPattern: pattern,
		});
		const repository = new ContentRepository(ctx.db);
		await repository.create({
			type: "posts",
			slug: "example-post",
			status: "draft",
			locale: "en",
			publishedAt: "2004-05-01T00:00:00.000Z",
			data: {},
		});
		await repository.create({
			type: "posts",
			slug: "example-post",
			status: "published",
			locale: "fr",
			publishedAt: "2004-05-01T00:00:00.000Z",
			data: {},
		});

		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "other",
				link: "https://wp.test/2004/05/01/example-post/",
				collection: "posts",
				pattern,
				item: {
					id: "other",
					slug: "other",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(result).toEqual([
			{
				title: "other",
				error:
					"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it("checks a later published locale instead of stopping at the first row", async () => {
		const pattern = "/{year}/{month}/{day}/{slug}";
		await new SchemaRegistry(ctx.db).createCollection({
			slug: "posts",
			label: "Posts",
			urlPattern: pattern,
		});
		const repository = new ContentRepository(ctx.db);
		await repository.create({
			type: "posts",
			slug: "example-post",
			status: "published",
			locale: "en",
			publishedAt: "2004-05-02T00:00:00.000Z",
			data: {},
		});
		await repository.create({
			type: "posts",
			slug: "example-post",
			status: "published",
			locale: "fr",
			publishedAt: "2004-05-01T00:00:00.000Z",
			data: {},
		});

		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "other",
				link: "https://wp.test/2004/05/01/example-post/",
				collection: "posts",
				pattern,
				item: {
					id: "other",
					slug: "other",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(result[0]?.error).toBe(
			"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
		);
	});

	it("checks non-en entries for id routes when i18n is disabled", async () => {
		const pattern = "/{id}";
		await new SchemaRegistry(ctx.db).createCollection({
			slug: "pages",
			label: "Pages",
			urlPattern: pattern,
		});
		await new ContentRepository(ctx.db).create({
			type: "pages",
			id: "fr-page",
			slug: "page",
			status: "published",
			locale: "fr",
			publishedAt: "2024-01-01T00:00:00.000Z",
			data: {},
		});

		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "other",
				link: "https://wp.test/fr-page/",
				collection: "pages",
				pattern,
				item: {
					id: "other",
					slug: "other",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(result[0]?.error).toBe(
			"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
		);
	});

	it("keeps locale matching when i18n is enabled", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		const pattern = "/{slug}";
		await new SchemaRegistry(ctx.db).createCollection({
			slug: "pages",
			label: "Pages",
			urlPattern: pattern,
		});
		await new ContentRepository(ctx.db).create({
			type: "pages",
			slug: "contact",
			status: "published",
			locale: "fr",
			publishedAt: "2024-01-01T00:00:00.000Z",
			data: {},
		});

		const results = await importWxrPermalinks(ctx.db, [
			{
				title: "translated",
				link: "https://wp.test/fr/contact/",
				collection: "pages",
				pattern,
				item: {
					id: "translated",
					slug: "translated",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "fr",
				},
			},
			{
				title: "unprefixed",
				link: "https://wp.test/contact/",
				collection: "pages",
				pattern,
				item: {
					id: "unprefixed",
					slug: "unprefixed",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(results[0]?.error).toBe(
			"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
		);
		expect(results[1]?.error).toBeUndefined();
	});
});
