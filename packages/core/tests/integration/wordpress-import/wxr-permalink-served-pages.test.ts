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
