import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import { _resetEnvCache } from "../../../src/api/public-url.js";
import { onRequest } from "../../../src/astro/middleware/redirect.js";
import { POST as executePost } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { handlersFromRuntime, createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectName,
} from "../../utils/test-db.js";

async function setup(dialect: DialectName) {
	const ctx = await setupForDialect(dialect);
	const db = ctx.db;
	const registry = new SchemaRegistry(db);
	for (const [slug, label, pattern] of [
		["posts", "Posts", "/posts/{slug}"],
		["pages", "Pages", "/{slug}/"],
	] as const) {
		await registry.createCollection({
			slug,
			label,
			labelSingular: label.slice(0, -1),
			urlPattern: pattern,
		});
		await registry.createField(slug, { slug: "title", label: "Title", type: "string" });
		await registry.createField(slug, { slug: "content", label: "Content", type: "portableText" });
		await registry.createField(slug, { slug: "excerpt", label: "Excerpt", type: "text" });
	}
	const runtime = createTestRuntime(db);
	return { ctx, db, runtime, emdash: handlersFromRuntime(runtime) };
}

function wxrItem({
	type,
	id,
	slug,
	link,
	status = "publish",
}: {
	type: string;
	id: number;
	slug: string;
	link: string;
	status?: string;
}) {
	return `<item>
		<title>${slug}</title>
		<wp:post_id>${id}</wp:post_id>
		<wp:post_type>${type}</wp:post_type>
		<wp:status>${status}</wp:status>
		<wp:post_name>${slug}</wp:post_name>
		<link>https://example.test${link}</link>
		<wp:post_date>2024-01-01 12:00:00</wp:post_date>
		<wp:post_date_gmt>2024-01-01 12:00:00</wp:post_date_gmt>
		<content:encoded><![CDATA[<p>${slug}</p>]]></content:encoded>
	</item>`;
}

function wxr(items: string) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
	<channel><title>Test Site</title><link>https://example.test</link>${items}</channel>
</rss>`;
}

async function executeImport(
	wxrText: string,
	emdash: ReturnType<typeof handlersFromRuntime>,
	mappings: Record<string, { collection: string; enabled: boolean }>,
) {
	const form = (phase: string, data?: { cursor: unknown; chunk: unknown }) => {
		const body = new FormData();
		body.append("file", new File([wxrText], "test.xml", { type: "text/xml" }));
		body.append("config", JSON.stringify({ postTypeMappings: mappings, skipExisting: false }));
		body.append("phase", phase);
		if (data) {
			body.append("cursor", JSON.stringify(data.cursor));
			body.append("chunk", JSON.stringify(data.chunk));
		}
		return {
			request: new Request("http://localhost/_emdash/api/import/wordpress/execute", {
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
				body,
			}),
			locals: { emdash, user: { id: "test-admin", role: 50 } },
		};
	};
	const taxonomy = await executePost(executeContext(form("taxonomy")));
	expect(taxonomy.status).toBe(200);
	const prepared = await taxonomy.json();
	const content = await executePost(executeContext(form("content", prepared.data)));
	expect(content.status).toBe(200);
	return content.json();
}

function executeContext(context: unknown) {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion
	return context as any;
}

type MiddlewareContext = Parameters<typeof onRequest>[0];

function middlewareContext(
	pathname: string,
	db: Awaited<ReturnType<typeof setup>>["db"],
): MiddlewareContext {
	const url = new URL(`https://example.com${pathname}`);
	return {
		url,
		request: new Request(url),
		locals: { emdash: { db } },
		redirect: (destination: string, status: number) =>
			new Response(null, { status, headers: { Location: destination } }),
	} as unknown as MiddlewareContext;
}

describeEachDialect("WordPress permalink roots and publish cleanup", (dialect) => {
	let harness: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		harness = await setup(dialect);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		_resetEnvCache();
		await teardownForDialect(harness.ctx);
	});

	it.each(["/", "/archive/", "/fr/", "/archive/fr/"])(
		"does not create a redirect for a static front page at %s",
		async (source) => {
			if (source.includes("fr")) setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
			if (source.startsWith("/archive")) vi.stubEnv("BASE_URL", "/archive/");
			const result = await executeImport(
				wxr(wxrItem({ type: "page", id: 1, slug: "home", link: source })),
				harness.emdash,
				{ page: { collection: "pages", enabled: true } },
			);
			expect(result.data.result).toMatchObject({ imported: 1, errors: [] });
			expect(await harness.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
		},
	);

	it("removes an older importer-owned root redirect on a rerun", async () => {
		await new RedirectRepository(harness.db).create({
			source: "/",
			destination: "/home",
			auto: true,
			groupName: "WordPress import",
		});
		const result = await executeImport(
			wxr(wxrItem({ type: "page", id: 1, slug: "home", link: "/" })),
			harness.emdash,
			{ page: { collection: "pages", enabled: true } },
		);
		expect(result.data.result).toMatchObject({ imported: 1, errors: [] });
		expect(await harness.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});

	it.each([
		{ source: "/archive/contact", enabled: false, isPattern: false, type: 301 },
		{ source: "/archive/contact", enabled: true, isPattern: true, type: 301 },
		{ source: "/archive/contact", enabled: true, isPattern: false, type: 302 },
		{ source: "/archive/contact/", enabled: false, isPattern: false, type: 301 },
		{ source: "/archive/contact/", enabled: true, isPattern: true, type: 301 },
		{ source: "/archive/contact/", enabled: true, isPattern: false, type: 302 },
	])(
		"preserves a protected importer redirect when a published page uses its canonical path ($source, $type, enabled=$enabled, pattern=$isPattern)",
		async ({ source, enabled, isPattern, type }) => {
			vi.stubEnv("BASE_URL", "/archive/");
			const repository = new RedirectRepository(harness.db);
			const protectedRedirect = await repository.create({
				source,
				destination: "/keep",
				type,
				enabled,
				isPattern,
				auto: true,
				groupName: "WordPress import",
			});
			const before = await harness.db
				.selectFrom("_emdash_redirects")
				.selectAll()
				.where("id", "=", protectedRedirect.id)
				.executeTakeFirstOrThrow();

			const result = await executeImport(
				wxr(wxrItem({ type: "page", id: 1, slug: "contact", link: "/archive/contact/" })),
				harness.emdash,
				{ page: { collection: "pages", enabled: true } },
			);
			expect(result.data.result).toMatchObject({
				imported: 1,
				errors: enabled
					? [
							{
								title: "contact",
								error:
									"Imported content's canonical URL conflicts with a protected WordPress import redirect",
							},
						]
					: [],
			});
			expect(
				await harness.db
					.selectFrom("ec_pages")
					.select(["slug", "status"])
					.where("slug", "=", "contact")
					.executeTakeFirstOrThrow(),
			).toEqual({ slug: "contact", status: "published" });
			// Check the persisted rule before middleware hit bookkeeping changes it.
			expect(await harness.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([
				before,
			]);

			const next = vi.fn(async () => new Response("ok", { status: 200 }));
			try {
				invalidateRedirectCache();
				const response = await onRequest(middlewareContext(source, harness.db), next);
				if (enabled) {
					expect(response.status).toBe(type);
					expect(response.headers.get("location")).toBe("/keep");
					expect(next).not.toHaveBeenCalled();
				} else {
					expect(response.status).toBe(200);
					expect(response.headers.has("location")).toBe(false);
					expect(next).toHaveBeenCalledOnce();
				}
			} finally {
				invalidateRedirectCache();
			}
		},
	);

	it.each([
		{ isPattern: false, type: 302 },
		{ isPattern: true, type: 301 },
	])(
		"does not create another redirect to a protected canonical path ($type, pattern=$isPattern)",
		async ({ isPattern, type }) => {
			vi.stubEnv("BASE_URL", "/archive/");
			const repository = new RedirectRepository(harness.db);
			const rule = await repository.create({
				source: "/archive/contact",
				destination: "/keep",
				auto: true,
				enabled: true,
				isPattern,
				type,
				groupName: "WordPress import",
			});
			const result = await executeImport(
				wxr(wxrItem({ type: "page", id: 1, slug: "contact", link: "/archive/old-contact/" })),
				harness.emdash,
				{ page: { collection: "pages", enabled: true } },
			);
			expect(result.data.result).toMatchObject({
				imported: 1,
				errors: [
					{
						title: "contact",
						error:
							"Imported content's canonical URL conflicts with a protected WordPress import redirect",
					},
				],
			});
			expect(await repository.findById(rule.id)).toEqual(rule);
			expect(await repository.findBySource("/archive/old-contact")).toBeNull();
		},
	);

	it.each([null, "Auto: slug change"])(
		"keeps legacy automatic cleanup for group %s",
		async (groupName) => {
			vi.stubEnv("BASE_URL", "/archive/");
			await new RedirectRepository(harness.db).create({
				source: "/archive/contact",
				destination: "/old",
				auto: true,
				enabled: false,
				groupName,
			});
			const result = await executeImport(
				wxr(wxrItem({ type: "page", id: 1, slug: "contact", link: "/archive/contact/" })),
				harness.emdash,
				{ page: { collection: "pages", enabled: true } },
			);
			expect(result.data.result).toMatchObject({ imported: 1, errors: [] });
			expect(await harness.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
		},
	);

	it.each([
		{ base: "/", source: "/contact/", destination: "/posts/contact", i18n: false },
		{
			base: "/archive/",
			source: "/archive/contact/",
			destination: "/archive/posts/contact",
			i18n: false,
		},
		{ base: "/", source: "/contact/", destination: "/posts/contact", i18n: true },
	])(
		"removes the imported redirect when a page is published at the canonical path (base=$base, i18n=$i18n)",
		async ({ base, source, destination, i18n }) => {
			if (base !== "/") vi.stubEnv("BASE_URL", base);
			if (i18n) {
				setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: false });
				_resetAstroI18nCacheForTests();
			}
			const result = await executeImport(
				wxr(wxrItem({ type: "post", id: 1, slug: "contact", link: source })),
				harness.emdash,
				{ post: { collection: "posts", enabled: true } },
			);
			expect(result.data.result).toMatchObject({ imported: 1, errors: [] });
			expect(
				await harness.db
					.selectFrom("_emdash_redirects")
					.select(["source", "destination"])
					.execute(),
			).toEqual([{ source: source.slice(0, -1), destination }]);

			const created = await harness.runtime.handleContentCreate("pages", {
				data: { title: "Contact" },
				slug: "contact",
			});
			expect(created.success).toBe(true);
			expect(await harness.db.selectFrom("_emdash_redirects").selectAll().execute()).toHaveLength(
				1,
			);
			if (!created.success) return;
			const published = await harness.runtime.handleContentPublish("pages", created.data.item.id);
			expect(published.success).toBe(true);
			expect(await harness.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
		},
	);

	it("removes only the localized import redirect when a translated page is published", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});
		_resetAstroI18nCacheForTests();

		const result = await executeImport(
			wxr(wxrItem({ type: "post", id: 1, slug: "contact", link: "/contact/" })),
			harness.emdash,
			{ post: { collection: "posts", enabled: true } },
		);
		expect(result.data.result).toMatchObject({ imported: 1, errors: [] });
		const repository = new RedirectRepository(harness.db);
		const englishRedirect = await repository.findBySource("/contact");
		expect(englishRedirect).toMatchObject({
			source: "/contact",
			destination: "/posts/contact",
			type: 301,
			enabled: true,
			auto: true,
		});
		if (!englishRedirect) throw new Error("English import redirect was not created");
		const englishBefore = await harness.db
			.selectFrom("_emdash_redirects")
			.selectAll()
			.where("id", "=", englishRedirect.id)
			.executeTakeFirstOrThrow();

		const frenchRedirect = await repository.create({
			source: "/fr/contact",
			destination: "/fr/posts/old",
			type: 301,
			enabled: true,
			isPattern: false,
			auto: true,
			groupName: "WordPress import",
		});
		const created = await harness.runtime.handleContentCreate("pages", {
			data: { title: "Contact" },
			slug: "contact",
			locale: "fr",
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const published = await harness.runtime.handleContentPublish("pages", created.data.item.id);
		expect(published.success).toBe(true);
		expect(
			await harness.db
				.selectFrom("ec_pages")
				.select(["status", "locale"])
				.where("id", "=", created.data.item.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "published", locale: "fr" });
		expect(await repository.findById(frenchRedirect.id)).toBeNull();
		expect(
			await harness.db
				.selectFrom("_emdash_redirects")
				.selectAll()
				.where("id", "=", englishRedirect.id)
				.executeTakeFirstOrThrow(),
		).toEqual(englishBefore);

		const next = vi.fn(async () => new Response("ok", { status: 200 }));
		try {
			invalidateRedirectCache();
			const englishResponse = await onRequest(middlewareContext("/contact", harness.db), next);
			expect(englishResponse.status).toBe(301);
			expect(englishResponse.headers.get("location")).toBe("/posts/contact");
			next.mockClear();
			const frenchResponse = await onRequest(middlewareContext("/fr/contact", harness.db), next);
			expect(frenchResponse.status).toBe(200);
			expect(frenchResponse.headers.has("location")).toBe(false);
			expect(next).toHaveBeenCalledOnce();
		} finally {
			invalidateRedirectCache();
		}
	});

	it.each([
		{
			base: "/archive/",
			prefixDefaultLocale: false,
			locale: "fr",
			localizedSource: "/archive/fr/contact",
		},
		{ base: "/", prefixDefaultLocale: true, locale: "en", localizedSource: "/en/contact" },
	])(
		"preserves an unprefixed WordPress source outside the published page's path (base=$base, prefixDefaultLocale=$prefixDefaultLocale)",
		async ({ base, prefixDefaultLocale, locale, localizedSource }) => {
			if (base !== "/") vi.stubEnv("BASE_URL", base);
			setI18nConfig({
				defaultLocale: "en",
				locales: ["en", "fr"],
				prefixDefaultLocale,
			});
			_resetAstroI18nCacheForTests();
			const result = await executeImport(
				wxr(wxrItem({ type: "post", id: 1, slug: "contact", link: "/contact/" })),
				harness.emdash,
				{ post: { collection: "posts", enabled: true } },
			);
			expect(result.data.result).toMatchObject({ imported: 1, errors: [] });
			const repository = new RedirectRepository(harness.db);
			const legacy = await repository.findBySource("/contact");
			expect(legacy).toMatchObject({
				source: "/contact",
				destination: prefixDefaultLocale ? "/en/posts/contact" : "/archive/posts/contact",
			});
			if (!legacy) throw new Error("Legacy import redirect was not created");
			const before = await repository.findById(legacy.id);
			await repository.create({
				source: localizedSource,
				destination: `/${locale}/posts/old`,
				type: 301,
				enabled: true,
				isPattern: false,
				auto: true,
				groupName: "WordPress import",
			});

			const created = await harness.runtime.handleContentCreate("pages", {
				data: { title: "Contact" },
				slug: "contact",
				locale,
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			const published = await harness.runtime.handleContentPublish("pages", created.data.item.id);
			expect(published.success).toBe(true);
			expect(await repository.findById(legacy.id)).toEqual(before);
			expect(await repository.findBySource(localizedSource)).toBeNull();
		},
	);
});
