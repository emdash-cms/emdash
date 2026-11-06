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

const pattern = "/café/{slug}";

describeEachDialect("WordPress permalink Unicode route matching", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await new SchemaRegistry(ctx.db).createCollection({
			slug: "pages",
			label: "Pages",
			urlPattern: pattern,
		});
		const repository = new ContentRepository(ctx.db);
		await repository.create({
			type: "pages",
			slug: "hello",
			status: "published",
			publishedAt: "2024-01-01T00:00:00.000Z",
			data: {},
		});
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownForDialect(ctx);
	});

	it("recognizes raw and percent-encoded Unicode route prefixes as live URLs", async () => {
		const results = await importWxrPermalinks(ctx.db, [
			{
				title: "other",
				link: "https://wp.test/café/hello/",
				collection: "pages",
				pattern,
				item: {
					id: "other-raw",
					slug: "other",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "en",
				},
			},
			{
				title: "other encoded",
				link: "https://wp.test/caf%C3%A9/hello/",
				collection: "pages",
				pattern,
				item: {
					id: "other-encoded",
					slug: "other",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(results).toEqual([
			{
				title: "other",
				error: "Could not create redirect: the WordPress permalink is another entry's live URL",
			},
			{
				title: "other encoded",
				error: "Could not create redirect: the WordPress permalink is another entry's live URL",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it("preserves dot literals beside placeholders while normalizing a pattern", async () => {
		await new SchemaRegistry(ctx.db).updateCollection("pages", { urlPattern: "/{year}./{slug}" });
		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "other",
				link: "https://wp.test/2024./hello/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "other",
					slug: "other",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "en",
				},
			},
		]);
		expect(result).toEqual([
			{
				title: "other",
				error: "Could not create redirect: the WordPress permalink is another entry's live URL",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it("normalizes Unicode prefixes after a locale prefix", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		await new ContentRepository(ctx.db).create({
			type: "pages",
			slug: "bonjour",
			status: "published",
			publishedAt: "2024-01-01T00:00:00.000Z",
			locale: "fr",
			data: {},
		});

		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "autre",
				link: "https://wp.test/fr/caf%C3%A9/bonjour/",
				collection: "pages",
				pattern,
				item: {
					id: "other-fr",
					slug: "autre",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "fr",
				},
			},
		]);

		expect(result).toEqual([
			{
				title: "autre",
				error: "Could not create redirect: the WordPress permalink is another entry's live URL",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});
});
