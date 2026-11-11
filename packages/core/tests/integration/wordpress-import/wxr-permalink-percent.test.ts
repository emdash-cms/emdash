import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
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

const conflict =
	"Could not create redirect: the WordPress permalink conflicts with a page served by the site";

type ExistingItem = {
	id: string;
	slug: string;
	locale?: string;
	publishedAt?: string;
};

async function createCollection(ctx: DialectTestContext, slug: string, urlPattern: string) {
	await new SchemaRegistry(ctx.db).createCollection({
		slug,
		label: slug,
		urlPattern,
	});
}

async function createExisting(ctx: DialectTestContext, item: ExistingItem, type = "posts") {
	return new ContentRepository(ctx.db).create({
		type,
		id: item.id,
		slug: item.slug,
		locale: item.locale ?? "en",
		status: "published",
		publishedAt: item.publishedAt ?? "2024-01-01T00:00:00.000Z",
		data: {},
	});
}

function importedItem(id: string, slug: string, locale = "en") {
	return {
		id,
		slug,
		status: "published" as const,
		publishedAt: "2024-01-01T00:00:00.000Z",
		locale,
	};
}

describeEachDialect("WordPress permalink percent-encoding route matching", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await createCollection(ctx, "posts", "/{slug}");
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		vi.unstubAllEnvs();
		await teardownForDialect(ctx);
	});

	it("reports a conflict for a percent-encoded source served by an existing entry", async () => {
		const created = await handleContentCreate(ctx.db, "posts", {
			slug: "50%-off",
			status: "published",
			data: {},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error("Percent-bearing content was not created");
		const before = await ctx.db.selectFrom("ec_posts").selectAll().execute();

		const errors = await importWxrPermalinks(ctx.db, [
			{
				title: "Other imported post",
				link: "https://wp.test/50%25-off/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: importedItem("other", "other"),
			},
		]);

		expect(errors).toEqual([{ title: "Other imported post", error: conflict }]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
		expect(await ctx.db.selectFrom("ec_posts").selectAll().execute()).toEqual(before);
	});

	it.each(["literal%41", "literal%3F", "literal%2F", "literal%25"])(
		"guards the existing entry for the literal percent escape %s",
		async (slug) => {
			await createExisting(ctx, { id: `existing-${slug}`, slug });
			const before = await ctx.db.selectFrom("ec_posts").selectAll().execute();
			const source = `/${encodeURIComponent(slug)}/`;

			const errors = await importWxrPermalinks(ctx.db, [
				{
					title: `Imported ${slug}`,
					link: `https://wp.test${source}`,
					collection: "posts",
					pattern: "/posts/{slug}",
					item: importedItem(`other-${slug}`, `other-${slug}`),
				},
			]);

			expect(errors).toEqual([{ title: `Imported ${slug}`, error: conflict }]);
			expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
			expect(await ctx.db.selectFrom("ec_posts").selectAll().execute()).toEqual(before);
		},
	);

	it.each([
		{ pattern: "/~user/{slug}", source: "/%7euser/literal%2541/", slug: "literal%41" },
		{ pattern: "/50%/{slug}", source: "/50%25/x/", slug: "x" },
		{ pattern: "/~{slug}", source: "/%7eliteral%2541/", slug: "literal%41" },
	])(
		"protects canonical pages behind encoded literal prefixes ($source)",
		async ({ pattern, source, slug }) => {
			await createCollection(ctx, "prefixed", pattern);
			await createExisting(ctx, { id: "prefixed-existing", slug }, "prefixed");
			const before = await ctx.db.selectFrom("ec_prefixed").selectAll().execute();
			expect(
				await importWxrPermalinks(ctx.db, [
					{
						title: "Other",
						link: `https://wp.test${source}`,
						collection: "posts",
						pattern: "/posts/{slug}",
						item: importedItem("other", "other"),
					},
				]),
			).toEqual([{ title: "Other", error: conflict }]);
			expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
			expect(await ctx.db.selectFrom("ec_prefixed").selectAll().execute()).toEqual(before);
		},
	);

	it("protects a percent-bearing translated entry", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		_resetAstroI18nCacheForTests();
		await createExisting(ctx, { id: "french", slug: "50%-off", locale: "fr" });
		expect(
			await importWxrPermalinks(ctx.db, [
				{
					title: "Other",
					link: "https://wp.test/fr/50%25-off/",
					collection: "posts",
					pattern: "/posts/{slug}",
					item: importedItem("other", "other"),
				},
			]),
		).toEqual([{ title: "Other", error: conflict }]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it.each(["/archive/", "/archive%25/"])(
		"matches encoded route prefixes and base %s",
		async (base) => {
			vi.stubEnv("BASE_URL", base);
			await createCollection(ctx, "cafe", "/café/{slug}");
			await createCollection(ctx, "sales", "/sale%25/{slug}");
			await createExisting(ctx, { id: "cafe-existing", slug: "bonjour" }, "cafe");
			await new ContentRepository(ctx.db).create({
				type: "sales",
				id: "sale-existing",
				slug: "today",
				status: "published",
				publishedAt: "2024-01-01T00:00:00.000Z",
				data: {},
			});

			const errors = await importWxrPermalinks(ctx.db, [
				{
					title: "Cafe duplicate",
					link: `https://wp.test${base}caf%c3%a9/bonjour/`,
					collection: "cafe",
					pattern: "/café/{slug}",
					item: importedItem("cafe-other", "other"),
				},
				{
					title: "Sale duplicate",
					link: `https://wp.test${base}sale%25/today/`,
					collection: "sales",
					pattern: "/sale%25/{slug}",
					item: importedItem("sale-other", "other"),
				},
			]);

			expect(errors).toEqual([
				{ title: "Cafe duplicate", error: conflict },
				{ title: "Sale duplicate", error: conflict },
			]);
			expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
		},
	);
});
