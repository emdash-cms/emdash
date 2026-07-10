/**
 * Tests for render-path hreflang alternates (#1690).
 *
 * Mirrors the sitemap route's semantics: alternates per published
 * translation sibling (including self), `x-default` on the
 * default-locale variant, unroutable locales dropped, and empty output
 * when i18n is disabled. `astro:i18n` isn't available under vitest, so
 * `localizePath` uses its manual-prefix fallback — the same behaviour
 * default-routing sites get.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { getHreflangAlternatesWithDb } from "../../../src/seo/hreflang.js";

const SITE = "https://example.com";

describe("getHreflangAlternates (#1690)", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await runMigrations(db);
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await db
			.updateTable("_emdash_collections")
			.set({ url_pattern: "/blog/{slug}" })
			.where("slug", "=", "post")
			.execute();

		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: false });
		_resetAstroI18nCacheForTests();
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await db.destroy();
	});

	async function createPair() {
		const en = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			locale: "en",
		});
		const fr = await repo.create({
			type: "post",
			slug: "bonjour",
			data: { title: "Bonjour" },
			status: "published",
			locale: "fr",
			translationOf: en.id,
		});
		return { en, fr };
	}

	it("returns alternates for every published sibling plus x-default", async () => {
		const { en } = await createPair();

		const alternates = await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE });

		expect(alternates).toEqual([
			{ hreflang: "en", href: `${SITE}/blog/hello` },
			{ hreflang: "fr", href: `${SITE}/fr/blog/bonjour` },
			{ hreflang: "x-default", href: `${SITE}/blog/hello` },
		]);
	});

	it("returns the same set when resolved from a non-default sibling", async () => {
		const { fr } = await createPair();

		const alternates = await getHreflangAlternatesWithDb(db, "post", fr.id, { siteUrl: SITE });

		expect(alternates.map((a) => a.hreflang)).toEqual(["en", "fr", "x-default"]);
		expect(alternates.at(-1)?.href).toBe(`${SITE}/blog/hello`);
	});

	it("annotates untranslated entries with self + x-default", async () => {
		const en = await repo.create({
			type: "post",
			slug: "solo",
			data: { title: "Solo" },
			status: "published",
			locale: "en",
		});

		const alternates = await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE });

		expect(alternates).toEqual([
			{ hreflang: "en", href: `${SITE}/blog/solo` },
			{ hreflang: "x-default", href: `${SITE}/blog/solo` },
		]);
	});

	it("excludes unpublished siblings", async () => {
		const en = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			locale: "en",
		});
		await repo.create({
			type: "post",
			slug: "bonjour",
			data: { title: "Bonjour" },
			status: "draft",
			locale: "fr",
			translationOf: en.id,
		});

		const alternates = await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE });

		expect(alternates.map((a) => a.hreflang)).toEqual(["en", "x-default"]);
	});

	it("drops siblings whose locale is not in the configured list", async () => {
		const en = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			locale: "en",
		});
		await repo.create({
			type: "post",
			slug: "hallo",
			data: { title: "Hallo" },
			status: "published",
			locale: "de", // not in ["en", "fr"]
			translationOf: en.id,
		});

		const alternates = await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE });

		expect(alternates.map((a) => a.hreflang)).toEqual(["en", "x-default"]);
	});

	it("falls back to the first routable variant for x-default when the default locale is missing", async () => {
		setI18nConfig({ defaultLocale: "de", locales: ["de", "en", "fr"], prefixDefaultLocale: false });
		_resetAstroI18nCacheForTests();
		const { en } = await createPair();

		const alternates = await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE });

		const xDefault = alternates.find((a) => a.hreflang === "x-default");
		expect(xDefault?.href).toBe(`${SITE}/en/blog/hello`);
	});

	it("returns empty when i18n is disabled", async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		const en = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			locale: "en",
		});

		expect(await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE })).toEqual([]);
	});

	it("returns empty when no absolute site URL is available", async () => {
		const { en } = await createPair();

		expect(await getHreflangAlternatesWithDb(db, "post", en.id)).toEqual([]);
	});

	it("returns empty for a relative site URL", async () => {
		const { en } = await createPair();

		expect(await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: "/base" })).toEqual([]);
	});

	it("excludes noindex siblings, matching the sitemap filter", async () => {
		const { en, fr } = await createPair();
		await db
			.insertInto("_emdash_seo")
			.values({ collection: "post", content_id: fr.id, seo_no_index: 1 })
			.execute();

		const alternates = await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE });

		expect(alternates.map((a) => a.hreflang)).toEqual(["en", "x-default"]);
	});

	it("returns empty when the entry itself is noindex", async () => {
		const { en } = await createPair();
		await db
			.insertInto("_emdash_seo")
			.values({ collection: "post", content_id: en.id, seo_no_index: 1 })
			.execute();

		expect(await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE })).toEqual([]);
	});

	it("returns empty for a missing entry", async () => {
		expect(await getHreflangAlternatesWithDb(db, "post", "nope", { siteUrl: SITE })).toEqual([]);
	});

	it("uses the default /{collection}/{slug} pattern when none is configured", async () => {
		await db
			.updateTable("_emdash_collections")
			.set({ url_pattern: null })
			.where("slug", "=", "post")
			.execute();
		const { en } = await createPair();

		const alternates = await getHreflangAlternatesWithDb(db, "post", en.id, { siteUrl: SITE });

		expect(alternates[0]?.href).toBe(`${SITE}/post/hello`);
	});
});
