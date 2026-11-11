import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { pageRoutes } = vi.hoisted(() => ({
	pageRoutes: [] as Array<{ source: string; flags: string }>,
}));
vi.mock("virtual:emdash/page-routes", () => ({ pageRoutes }));

import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { importWxrPermalinks } from "../../../src/import/wxr-permalinks.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("WXR redirects protect served Astro pages", (dialect) => {
	let ctx: DialectTestContext;
	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		pageRoutes.length = 0;
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
	});
	afterEach(async () => {
		pageRoutes.length = 0;
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		vi.unstubAllEnvs();
		await teardownForDialect(ctx);
	});

	it.each([
		["/", /^\/contact\/?$/, "/contact/"],
		["/archive/", /^\/contact\/$/, "/archive/contact/"],
		["/", /^\/docs\/start\/?$/, "/docs/start/"],
		["/", /^\/fr\/café\/?$/, "/fr/caf%C3%A9/"],
	])("refuses a source matched by a public route under base %s", async (base, pattern, source) => {
		vi.stubEnv("BASE_URL", base);
		pageRoutes.push({ source: pattern.source, flags: pattern.flags });
		const errors = await importWxrPermalinks(ctx.db, [
			{
				title: "Imported post",
				link: `https://example.test${source}`,
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "contact",
					slug: "contact",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);
		expect(errors).toEqual([
			{
				title: "Imported post",
				error:
					"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it("does not decode a percent layer before matching a static route", async () => {
		pageRoutes.push({ source: "^/literalA/?$", flags: "" });
		const errors = await importWxrPermalinks(ctx.db, [
			{
				title: "Imported post",
				link: "https://example.test/literal%2541/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "literal",
					slug: "literal",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(errors).toEqual([]);
		expect(
			await ctx.db.selectFrom("_emdash_redirects").select(["source", "destination"]).execute(),
		).toEqual([{ source: "/literal%2541", destination: "/posts/literal" }]);
	});

	it("matches a static route's literal percent layer", async () => {
		pageRoutes.push({ source: "^/literal%41/?$", flags: "" });
		const errors = await importWxrPermalinks(ctx.db, [
			{
				title: "Imported post",
				link: "https://example.test/literal%2541/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "literal",
					slug: "literal",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(errors).toEqual([
			{
				title: "Imported post",
				error:
					"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it("preserves percent layers in a base URL while matching Unicode static routes", async () => {
		vi.stubEnv("BASE_URL", "/archive%2541/");
		pageRoutes.push({ source: "^/café/?$", flags: "" });
		const errors = await importWxrPermalinks(ctx.db, [
			{
				title: "Imported post",
				link: "https://example.test/archive%2541/caf%c3%a9/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "cafe",
					slug: "cafe",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(errors).toEqual([
			{
				title: "Imported post",
				error:
					"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it("keeps the raw source with a percent-encoded base when no static route matches", async () => {
		vi.stubEnv("BASE_URL", "/archive%2541/");
		pageRoutes.push({ source: "^/literalA/?$", flags: "" });
		const errors = await importWxrPermalinks(ctx.db, [
			{
				title: "Imported post",
				link: "https://example.test/archive%2541/literal%2541/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "literal",
					slug: "literal",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(errors).toEqual([]);
		expect(
			await ctx.db.selectFrom("_emdash_redirects").select(["source", "destination"]).execute(),
		).toEqual([
			{
				source: "/archive%2541/literal%2541",
				destination: "/archive%2541/posts/literal",
			},
		]);
	});

	it("still matches a static percent route under a percent-encoded base", async () => {
		vi.stubEnv("BASE_URL", "/archive%2541/");
		pageRoutes.push({ source: "^/literal%41/?$", flags: "" });
		const errors = await importWxrPermalinks(ctx.db, [
			{
				title: "Imported post",
				link: "https://example.test/archive%2541/literal%2541/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "literal",
					slug: "literal",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(errors).toEqual([
			{
				title: "Imported post",
				error:
					"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
			},
		]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it("still redirects a source outside the site's known page routes", async () => {
		pageRoutes.push({ source: "^/about/?$", flags: "" });
		expect(
			await importWxrPermalinks(ctx.db, [
				{
					title: "Imported post",
					link: "https://example.test/contact/",
					collection: "posts",
					pattern: "/posts/{slug}",
					item: {
						id: "contact",
						slug: "contact",
						status: "published",
						publishedAt: "2004-05-02T00:00:00.000Z",
						locale: "en",
					},
				},
			]),
		).toEqual([]);
		expect(
			await ctx.db.selectFrom("_emdash_redirects").select(["source", "destination"]).execute(),
		).toEqual([{ source: "/contact", destination: "/posts/contact" }]);
	});
});
