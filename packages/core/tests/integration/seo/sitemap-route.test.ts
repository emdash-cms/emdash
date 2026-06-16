/**
 * End-to-end tests for the per-collection sitemap route.
 *
 * Exercises the actual route handler (XML output, hreflang alternates,
 * urlset namespace) with EmDash i18n configured. The `astro:i18n`
 * virtual module isn't available in vitest, so `localizePath` falls
 * back to its manual prefix path -- which is also what most sites
 * with default routing will produce.
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getSitemap } from "../../../src/astro/routes/sitemap-[collection].xml.js";
import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

interface MockContextOpts {
	collectionSlug: string | undefined;
	db: Kysely<Database> | null;
	url?: string;
}

function mockContext(opts: MockContextOpts): Parameters<typeof getSitemap>[0] {
	const url = new URL(opts.url ?? "http://localhost:4321/sitemap-post.xml");
	return {
		params: { collection: opts.collectionSlug },
		locals: {
			emdash: opts.db ? { db: opts.db, config: undefined } : undefined,
		},
		url,
	} as unknown as APIContext;
}

describe("sitemap-[collection].xml route", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await runMigrations(db);
		repo = new ContentRepository(db);
		registry = new SchemaRegistry(db);

		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1, url_pattern: "/blog/{slug}" })
			.where("slug", "=", "post")
			.execute();
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await db.destroy();
	});

	it("returns a 500 when emdash is not configured", async () => {
		const res = await getSitemap(mockContext({ collectionSlug: "post", db: null }));
		expect(res.status).toBe(500);
	});

	it("returns a 404 when the collection has no published content", async () => {
		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(404);
	});

	it("renders a non-i18n sitemap with one <url> per row", async () => {
		setI18nConfig(null);
		await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});
		await repo.create({
			type: "post",
			slug: "world",
			data: { title: "World" },
			status: "published",
		});

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		// Sitemap + image namespaces declared; no xhtml when i18n is off.
		expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
		expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
		expect(xml).not.toContain("xmlns:xhtml");
		expect(xml).not.toContain("xhtml:link");

		expect(xml).toContain("<loc>http://localhost:4321/blog/hello</loc>");
		expect(xml).toContain("<loc>http://localhost:4321/blog/world</loc>");
	});

	it("emits an <image:image> entry for rows with an SEO image", async () => {
		setI18nConfig(null);
		const post = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});
		// SEO panel stores seo_image as a root-relative media API path.
		await db
			.insertInto("_emdash_seo")
			.values({
				collection: "post",
				content_id: post.id,
				seo_title: null,
				seo_description: null,
				seo_image: "/_emdash/api/media/file/01ABCDEF.webp",
				seo_canonical: null,
				seo_no_index: 0,
			})
			.execute();

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		// image namespace declared + absolute <image:loc> emitted.
		expect(xml).toContain(
			'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
		);
		expect(xml).toContain(
			"<image:loc>http://localhost:4321/_emdash/api/media/file/01ABCDEF.webp</image:loc>",
		);
	});

	it("omits <image:image> for rows without an SEO image", async () => {
		setI18nConfig(null);
		await repo.create({
			type: "post",
			slug: "no-image",
			data: { title: "No image" },
			status: "published",
		});

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		expect(xml).toContain("<loc>http://localhost:4321/blog/no-image</loc>");
		expect(xml).not.toContain("<image:image>");
	});

	it("emits hreflang alternates for translation siblings when i18n is enabled", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});

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
			status: "published",
			locale: "fr",
			translationOf: en.id,
		});

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		// xhtml namespace declared on urlset.
		expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');

		// Default-locale row sits at /blog/hello (no prefix); French row
		// has its own slug ("bonjour") and is prefixed with /fr.
		expect(xml).toContain("<loc>http://localhost:4321/blog/hello</loc>");
		expect(xml).toContain("<loc>http://localhost:4321/fr/blog/bonjour</loc>");

		// Each <url> declares both siblings + x-default pointing at the
		// default-locale variant.
		const enUrlMatch = xml.match(
			/<url>(?:(?!<\/url>)[\s\S])*<loc>http:\/\/localhost:4321\/blog\/hello<\/loc>[\s\S]*?<\/url>/,
		);
		expect(enUrlMatch).not.toBeNull();
		const enUrlBlock = enUrlMatch![0];
		expect(enUrlBlock).toContain(
			'<xhtml:link rel="alternate" hreflang="en" href="http://localhost:4321/blog/hello" />',
		);
		expect(enUrlBlock).toContain(
			'<xhtml:link rel="alternate" hreflang="fr" href="http://localhost:4321/fr/blog/bonjour" />',
		);
		expect(enUrlBlock).toContain(
			'<xhtml:link rel="alternate" hreflang="x-default" href="http://localhost:4321/blog/hello" />',
		);
	});

	it("prefixes every locale when prefixDefaultLocale is true", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: true,
		});

		await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			locale: "en",
		});

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		expect(xml).toContain("<loc>http://localhost:4321/en/blog/hello</loc>");
		expect(xml).not.toContain("<loc>http://localhost:4321/blog/hello</loc>");
	});

	it("emits a single <url> with no alternates for rows without siblings", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});

		await repo.create({
			type: "post",
			slug: "solo",
			data: { title: "Solo" },
			status: "published",
			locale: "en",
		});

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		// Single-row translation_group -> no xhtml:link entries.
		expect(xml).toContain("<loc>http://localhost:4321/blog/solo</loc>");
		expect(xml).not.toContain("xhtml:link");
	});

	it("drops rows whose locale isn't in the configured i18n.locales list", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});

		await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			locale: "en",
		});
		// `de` isn't a configured locale -- the site has no /de/ route.
		// Better to drop the entry than to publish a sitemap link that
		// 404s.
		await repo.create({
			type: "post",
			slug: "hallo",
			data: { title: "Hallo" },
			status: "published",
			locale: "de",
		});

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		expect(xml).toContain("<loc>http://localhost:4321/blog/hello</loc>");
		expect(xml).not.toContain("/de/");
		expect(xml).not.toContain('hreflang="de"');
		expect(xml).not.toContain("hallo");
	});

	it("omits unroutable siblings from hreflang alternates", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});

		// English source + French translation (routable) + German
		// translation (locale not configured -- unroutable).
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
			status: "published",
			locale: "fr",
			translationOf: en.id,
		});
		await repo.create({
			type: "post",
			slug: "hallo",
			data: { title: "Hallo" },
			status: "published",
			locale: "de",
			translationOf: en.id,
		});

		const res = await getSitemap(mockContext({ collectionSlug: "post", db }));
		expect(res.status).toBe(200);
		const xml = await res.text();

		// French + English routable rows present.
		expect(xml).toContain("<loc>http://localhost:4321/blog/hello</loc>");
		expect(xml).toContain("<loc>http://localhost:4321/fr/blog/bonjour</loc>");

		// German row dropped, and no German hreflang on remaining rows.
		expect(xml).not.toContain("/de/");
		expect(xml).not.toContain('hreflang="de"');
		expect(xml).not.toContain("hallo");

		// English row still lists French as an alternate (and x-default).
		expect(xml).toContain(
			'<xhtml:link rel="alternate" hreflang="fr" href="http://localhost:4321/fr/blog/bonjour" />',
		);
		expect(xml).toContain(
			'<xhtml:link rel="alternate" hreflang="x-default" href="http://localhost:4321/blog/hello" />',
		);
	});
});
