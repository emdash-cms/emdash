import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import { onRequest as redirectMiddleware } from "../../../src/astro/middleware/redirect.js";
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

const AMBIGUOUS =
	"Skipped item has an ambiguous collection, slug and locale in this WXR; no permalink redirect was created";

type Harness = Awaited<ReturnType<typeof setup>>;

async function setup(dialect: DialectName) {
	const ctx = await setupForDialect(dialect);
	const registry = new SchemaRegistry(ctx.db);
	await registry.createCollection({
		slug: "pages",
		label: "Pages",
		labelSingular: "Page",
		urlPattern: "/pages/{slug}",
	});
	for (const field of [
		{ slug: "title", label: "Title", type: "string" as const },
		{ slug: "content", label: "Content", type: "portableText" as const },
		{ slug: "excerpt", label: "Excerpt", type: "text" as const },
	]) {
		await registry.createField("pages", field);
	}
	const runtime = createTestRuntime(ctx.db);
	return { ctx, db: ctx.db, emdash: handlersFromRuntime(runtime) };
}

function item({
	id,
	title,
	slug = "overview",
	link,
	host = "example.test",
	parent,
	localeMeta,
	translationGroup,
	category = false,
}: {
	id: number;
	title: string;
	slug?: string;
	link?: string;
	host?: string;
	parent?: number;
	localeMeta?: string;
	translationGroup?: number;
	category?: boolean;
}) {
	const absoluteLink = link?.startsWith("https://") ? link : link && `https://${host}${link}`;
	return `<item>
		<title>${title}</title>
		<wp:post_id>${id}</wp:post_id>
		<wp:post_type>page</wp:post_type>
		<wp:status>publish</wp:status>
		<wp:post_name>${slug}</wp:post_name>
		${parent === undefined ? "" : `<wp:post_parent>${parent}</wp:post_parent>`}
		${absoluteLink ? `<link>${absoluteLink}</link>` : ""}
		<wp:post_date>2024-01-01 12:00:00</wp:post_date>
		<wp:post_date_gmt>2024-01-01 12:00:00</wp:post_date_gmt>
		${category ? `<category domain="category" nicename="news">News</category>` : ""}
		${localeMeta ? `<wp:postmeta><wp:meta_key>_icl_lang_code</wp:meta_key><wp:meta_value>${localeMeta}</wp:meta_value></wp:postmeta>` : ""}
		${translationGroup ? `<wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value>${translationGroup}</wp:meta_value></wp:postmeta>` : ""}
		<content:encoded><![CDATA[<p>${title}</p>]]></content:encoded>
	</item>`;
}

function wxr(items: string, includeTaxonomy = false) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
	<channel><title>Test Site</title><link>https://example.test</link>
	${includeTaxonomy ? `<wp:category><wp:term_id>7</wp:term_id><wp:category_nicename>news</wp:category_nicename><wp:cat_name>News</wp:cat_name></wp:category>` : ""}
	${items}</channel>
</rss>`;
}

function formData(
	text: string,
	phase: string,
	data: { cursor: unknown; chunk: unknown } | undefined,
	skipExisting = true,
	uploadLocale?: string,
) {
	const body = new FormData();
	body.append("file", new File([text], "test.xml", { type: "text/xml" }));
	body.append(
		"config",
		JSON.stringify({
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting,
			...(uploadLocale ? { locale: uploadLocale } : {}),
		}),
	);
	body.append("phase", phase);
	if (data) {
		body.append("cursor", JSON.stringify(data.cursor));
		body.append("chunk", JSON.stringify(data.chunk));
	}
	return body;
}

async function post(
	harness: Harness,
	text: string,
	phase: string,
	data?: { cursor: unknown; chunk: unknown },
	skipExisting = true,
	uploadLocale?: string,
) {
	const response = await executePost({
		request: new Request("http://localhost/_emdash/api/import/wordpress/execute", {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
			body: formData(text, phase, data, skipExisting, uploadLocale),
		}),
		locals: { emdash: harness.emdash, user: { id: "test-admin", role: 50 } },
	} as any);
	expect(response.status).toBe(200);
	return (await response.json()).data;
}

async function importContent(
	harness: Harness,
	text: string,
	skipExisting = true,
	uploadLocale?: string,
) {
	const prepared = await post(harness, text, "taxonomy", undefined, skipExisting, uploadLocale);
	return (await post(harness, text, "content", prepared, skipExisting, uploadLocale)).result;
}

async function redirects(harness: Harness) {
	return new RedirectRepository(harness.db)
		.findMany({ limit: 100 })
		.then(({ items: rows }) =>
			rows
				.map(({ source, destination }) => ({ source, destination }))
				.sort((a, b) => a.source.localeCompare(b.source)),
		);
}

type RedirectContext = Parameters<typeof redirectMiddleware>[0];

function redirectContext(pathname: string, db: Harness["db"]): RedirectContext {
	const url = new URL(`https://example.test${pathname}`);
	return {
		url,
		request: new Request(url),
		locals: { emdash: { db } },
		redirect: (location: string, status: number) =>
			new Response(null, { status, headers: { Location: location } }),
		cache: { set: vi.fn() },
	} as unknown as RedirectContext;
}

describeEachDialect("WXR permalink identity across an import", (dialect) => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await setup(dialect);
	});

	afterEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownForDialect(harness.ctx);
	});

	it("lets the newly created duplicate own the redirect and reports the skipped duplicate", async () => {
		const text = wxr(
			item({ id: 1, title: "First", link: "/first/overview/", parent: 10 }) +
				item({ id: 2, title: "Second", link: "/second/overview/", parent: 20 }),
		);
		const first = await importContent(harness, text);
		expect(first).toMatchObject({
			imported: 1,
			skipped: 1,
			errors: [{ title: "Second", error: AMBIGUOUS }],
		});
		const created = await harness.db
			.selectFrom("ec_pages")
			.select(["id", "slug", "locale"])
			.executeTakeFirstOrThrow();
		expect(created).toMatchObject({ slug: "overview", locale: "en" });
		expect(await redirects(harness)).toEqual([
			{ source: "/first/overview", destination: "/pages/overview" },
		]);

		const before = await harness.db.selectFrom("ec_pages").selectAll().execute();
		const rerun = await importContent(harness, text);
		expect(rerun).toMatchObject({
			imported: 0,
			skipped: 2,
			errors: [
				{ title: "First", error: AMBIGUOUS },
				{ title: "Second", error: AMBIGUOUS },
			],
		});
		expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
		expect(await redirects(harness)).toEqual([
			{ source: "/first/overview", destination: "/pages/overview" },
		]);
	});

	it("uses the whole WXR, not the current content chunk, to detect duplicate identity", async () => {
		const items = [item({ id: 1, title: "First", link: "/first/overview/", parent: 10 })];
		for (let id = 2; id <= 30; id++) {
			items.push(item({ id, title: `Unique ${id}`, slug: `unique-${id}`, link: `/unique-${id}/` }));
		}
		items.push(item({ id: 31, title: "Second", link: "/second/overview/", parent: 20 }));
		const text = wxr(items.join("\n"), true);
		const prepared = await post(harness, text, "taxonomy");
		const first = await post(harness, text, "content", prepared);
		expect(first.result).toMatchObject({ imported: 30, skipped: 0, errors: [] });
		expect(first.done).toBe(false);
		const second = await post(harness, text, "content", first);
		expect(second.result).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [{ title: "Second", error: AMBIGUOUS }],
		});
		expect(second.done).toBe(true);
		expect(await redirects(harness)).toContainEqual({
			source: "/first/overview",
			destination: "/pages/overview",
		});
		expect(await new RedirectRepository(harness.db).findBySource("/second/overview")).toBeNull();
	});

	it("reuses a non-en stored item on a locale-less rerun with i18n disabled", async () => {
		const original = wxr(item({ id: 1, title: "French", link: "/fr/overview/", localeMeta: "fr" }));
		expect(await importContent(harness, original)).toMatchObject({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		const before = await harness.db.selectFrom("ec_pages").selectAll().execute();
		const rerun = wxr(item({ id: 1, title: "French", link: "/fr/overview/" }));
		expect(await importContent(harness, rerun)).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [],
		});
		expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
		expect(before).toHaveLength(1);
		expect(before[0]?.locale).toBe("fr");
		expect(await redirects(harness)).toEqual([
			{ source: "/fr/overview", destination: "/pages/overview" },
		]);
	});

	it("reuses the upload locale on a locale-less rerun with i18n enabled", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
		_resetAstroI18nCacheForTests();
		const text = wxr(item({ id: 1, title: "French", link: "/fr/overview/" }));
		const first = await importContent(harness, text, true, "fr");
		expect(first).toMatchObject({ imported: 1, skipped: 0, errors: [] });
		const before = await harness.db.selectFrom("ec_pages").selectAll().execute();
		expect(before).toHaveLength(1);

		const rerun = await importContent(harness, text);
		expect(rerun).toMatchObject({ imported: 0, skipped: 1, errors: [] });
		expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
		expect(before[0]?.locale).toBe("fr");
		expect(await redirects(harness)).toEqual([
			{ source: "/fr/overview", destination: "/fr/pages/overview" },
		]);
	});

	it("preserves a doubly encoded original link and retargets it on a skipped rerun", async () => {
		const text = wxr(item({ id: 1, title: "Overview", link: "/literal%2541/" }));
		expect(await importContent(harness, text)).toMatchObject({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		invalidateRedirectCache();
		await waitForDeferredTasks();
		expect(await redirects(harness)).toEqual([
			{ source: "/literal%2541", destination: "/pages/overview" },
		]);

		for (const path of ["/literal%2541", "/literal%2541/"]) {
			const response = await redirectMiddleware(
				redirectContext(path, harness.db),
				async () => new Response("not found", { status: 404 }),
			);
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe("/pages/overview");
		}
		for (const path of ["/literalA", "/literal%41"]) {
			const response = await redirectMiddleware(
				redirectContext(path, harness.db),
				async () => new Response("not found", { status: 404 }),
			);
			expect(response.status).toBe(404);
		}

		await new SchemaRegistry(harness.db).updateCollection("pages", {
			urlPattern: "/updated/{slug}",
		});
		expect(await importContent(harness, text)).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [],
		});
		invalidateRedirectCache();
		await waitForDeferredTasks();
		expect(
			await harness.db
				.selectFrom("_emdash_redirects")
				.select(["source", "destination", "is_pattern", "enabled", "type"])
				.execute(),
		).toEqual([
			{
				source: "/literal%2541",
				destination: "/updated/overview",
				is_pattern: 0,
				enabled: 1,
				type: 301,
			},
		]);
	});

	it.each([
		{ link: "/old/%5Bslug%5D/", source: "/old/[slug]" },
		{ link: "/old/[slug]/", source: "/old/[slug]" },
	])(
		"keeps an imported bracket permalink exact across skipped reruns ($link)",
		async ({ link, source }) => {
			const text = wxr(item({ id: 1, title: "Overview", link }));
			expect(await importContent(harness, text)).toMatchObject({
				imported: 1,
				skipped: 0,
				errors: [],
			});
			invalidateRedirectCache();
			await waitForDeferredTasks();

			await new SchemaRegistry(harness.db).updateCollection("pages", {
				urlPattern: "/updated/{slug}",
			});
			for (let rerun = 0; rerun < 2; rerun++) {
				expect(await importContent(harness, text)).toMatchObject({
					imported: 0,
					skipped: 1,
					errors: [],
				});
				invalidateRedirectCache();
				await waitForDeferredTasks();
			}

			expect(
				await harness.db
					.selectFrom("_emdash_redirects")
					.select(["source", "destination", "is_pattern", "enabled", "type"])
					.execute(),
			).toEqual([
				{ source, destination: "/updated/overview", is_pattern: 0, enabled: 1, type: 301 },
			]);
			for (const path of [link, source, `${source}/`]) {
				const response = await redirectMiddleware(
					redirectContext(path, harness.db),
					async () => new Response("not found", { status: 404 }),
				);
				expect(response.status).toBe(301);
				expect(response.headers.get("Location")).toBe("/updated/overview");
			}
			const unrelated = await redirectMiddleware(
				redirectContext("/old/unrelated", harness.db),
				async () => new Response("not found", { status: 404 }),
			);
			expect(unrelated.status).toBe(404);
		},
	);

	it("imports and serves escaped WordPress post names", async () => {
		const text = wxr(item({ id: 1, title: "Пр", slug: "%d0%bf%d1%80", link: "/%d0%bf%d1%80/" }));
		const result = await importContent(harness, text, false);
		expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [] });
		expect(
			await harness.db.selectFrom("ec_pages").select(["slug"]).executeTakeFirstOrThrow(),
		).toEqual({
			slug: "%d0%bf%d1%80",
		});
		expect(await redirects(harness)).toEqual([
			{ source: "/%D0%BF%D1%80", destination: "/pages/%25d0%25bf%25d1%2580" },
		]);

		invalidateRedirectCache();
		for (const path of ["/%d0%bf%d1%80", "/%d0%bf%d1%80/", "/%D0%BF%D1%80", "/%D0%BF%D1%80/"]) {
			const response = await redirectMiddleware(
				redirectContext(path, harness.db),
				async () => new Response("not found", { status: 404 }),
			);
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe("/pages/%25d0%25bf%25d1%2580");
		}
		invalidateRedirectCache();
	});

	it("imports an explicitly different language independently with i18n disabled", async () => {
		const english = wxr(
			item({ id: 1, title: "English", link: "/first/overview/", localeMeta: "en" }),
		);
		expect(await importContent(harness, english)).toMatchObject({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		const englishRedirects = await redirects(harness);
		const french = wxr(item({ id: 2, title: "French", link: "/fr/overview/", localeMeta: "fr" }));
		expect(await importContent(harness, french)).toMatchObject({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		const rows = await harness.db
			.selectFrom("ec_pages")
			.select(["id", "slug", "locale", "title"])
			.orderBy("locale")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows).toEqual([
			expect.objectContaining({ slug: "overview", locale: "en", title: "English" }),
			expect.objectContaining({ slug: "overview", locale: "fr", title: "French" }),
		]);
		expect(rows[0]?.id).not.toBe(rows[1]?.id);
		expect(await redirects(harness)).toEqual(englishRedirects);

		const before = await harness.db.selectFrom("ec_pages").selectAll().execute();
		expect(await importContent(harness, french)).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [],
		});
		expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
		expect(await redirects(harness)).toEqual(englishRedirects);

		await new SchemaRegistry(harness.db).updateCollection("pages", {
			urlPattern: "/updated/{slug}",
		});
		expect(await importContent(harness, english)).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [],
		});
		expect(await redirects(harness)).toEqual(englishRedirects);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
		_resetAstroI18nCacheForTests();
		expect(await importContent(harness, english)).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [],
		});
		expect(await redirects(harness)).toEqual([
			{ source: "/first/overview", destination: "/en/updated/overview" },
		]);
		expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
	});

	it.each([true, false])(
		"imports same-slug languages in one i18n-off WXR without redirects (skipExisting=%s)",
		async (skipExisting) => {
			const text = wxr(
				item({
					id: 1,
					title: "English",
					link: "/pages/overview/",
					localeMeta: "en",
					translationGroup: 42,
				}) +
					item({
						id: 2,
						title: "French",
						link: "/fr/overview/",
						localeMeta: "fr",
						translationGroup: 42,
					}),
			);
			expect(await importContent(harness, text, skipExisting)).toMatchObject({
				imported: 2,
				skipped: 0,
				errors: [],
			});
			expect(await redirects(harness)).toEqual([]);

			const before = await harness.db
				.selectFrom("ec_pages")
				.selectAll()
				.orderBy("locale")
				.execute();
			expect(before.map((row) => row.locale)).toEqual(["en", "fr"]);
			expect(typeof before[0]?.translation_group).toBe("string");
			expect(before[1]?.translation_group).toBe(before[0]?.translation_group);
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
			_resetAstroI18nCacheForTests();
			expect(await importContent(harness, text)).toMatchObject({
				imported: 0,
				skipped: 2,
				errors: [],
			});
			expect(
				await harness.db.selectFrom("ec_pages").selectAll().orderBy("locale").execute(),
			).toEqual(before);
			expect(await redirects(harness)).toEqual([
				{ source: "/fr/overview", destination: "/fr/pages/overview" },
				{ source: "/pages/overview", destination: "/en/pages/overview" },
			]);
		},
	);

	it.each([false, true])(
		"reports ambiguous stored languages on a locale-less skip-existing rerun (i18n=%s)",
		async (i18n) => {
			if (i18n) {
				setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
				_resetAstroI18nCacheForTests();
			}
			const original = wxr(
				item({
					id: 1,
					title: "English",
					link: i18n ? "/en/overview/" : "/overview/",
					localeMeta: "en",
					translationGroup: 42,
				}) +
					item({
						id: 2,
						title: "French",
						link: "/fr/overview/",
						localeMeta: "fr",
						translationGroup: 42,
					}),
			);
			expect(await importContent(harness, original)).toMatchObject({
				imported: 2,
				skipped: 0,
				errors: [],
			});
			const beforeData = await harness.db
				.selectFrom("ec_pages")
				.selectAll()
				.orderBy("locale")
				.execute();
			const beforeRedirects = await redirects(harness);

			const rerun = wxr(item({ id: 1, title: "English", slug: "overview" }));
			expect(await importContent(harness, rerun)).toMatchObject({
				imported: 0,
				skipped: 1,
				errors: [
					{
						title: "English",
						error: "Skipped item has ambiguous stored languages; no permalink redirect was created",
					},
				],
			});
			expect(
				await harness.db.selectFrom("ec_pages").selectAll().orderBy("locale").execute(),
			).toEqual(beforeData);
			expect(await redirects(harness)).toEqual(beforeRedirects);
		},
	);

	it("uses the whole WXR to import same-slug languages across a content chunk", async () => {
		const items = [item({ id: 1, title: "English", link: "/en/overview/", localeMeta: "en" })];
		for (let id = 2; id <= 30; id++) {
			items.push(item({ id, title: `Unique ${id}`, slug: `unique-${id}`, link: `/unique-${id}/` }));
		}
		items.push(item({ id: 31, title: "French", link: "/fr/overview/", localeMeta: "fr" }));
		const text = wxr(items.join("\n"), true);
		const prepared = await post(harness, text, "taxonomy");
		const first = await post(harness, text, "content", prepared);
		expect(first.result).toMatchObject({ imported: 30, skipped: 0, errors: [] });
		expect(first.done).toBe(false);
		const second = await post(harness, text, "content", first);
		expect(second.result).toMatchObject({ imported: 1, skipped: 0, errors: [] });
		expect(second.done).toBe(true);
		expect(
			await harness.db
				.selectFrom("ec_pages")
				.select(["slug", "locale"])
				.where("slug", "=", "overview")
				.orderBy("locale")
				.execute(),
		).toEqual([
			{ slug: "overview", locale: "en" },
			{ slug: "overview", locale: "fr" },
		]);
		expect(await new RedirectRepository(harness.db).findBySource("/en/overview")).toBeNull();
		expect(await new RedirectRepository(harness.db).findBySource("/fr/overview")).toBeNull();
		expect(await new RedirectRepository(harness.db).findBySource("/unique-2")).not.toBeNull();
	});

	it.each([
		{ chunked: false, reverse: false, encoded: false },
		{ chunked: false, reverse: true, encoded: false },
		{ chunked: true, reverse: false, encoded: false },
		{ chunked: true, reverse: true, encoded: false },
		{ chunked: false, reverse: false, encoded: true },
	])(
		"imports same-path localized pages but reports their shared source ($chunked, reverse=$reverse, encoded=$encoded)",
		async ({ chunked, reverse, encoded }) => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
			_resetAstroI18nCacheForTests();
			const shared = [
				item({
					id: 1,
					title: "English shared",
					link: encoded ? "https://en.example/over%76iew/" : "https://en.example/overview/",
					localeMeta: "en",
				}),
				item({
					id: 31,
					title: "French shared",
					link: "https://fr.example/overview/",
					localeMeta: "fr",
				}),
			];
			const items = chunked
				? [
						shared[0]!,
						...Array.from({ length: 29 }, (_, index) =>
							item({
								id: index + 2,
								title: `Filler ${index + 2}`,
								slug: `filler-${index + 2}`,
								link: `/filler-${index + 2}/`,
							}),
						),
						shared[1]!,
					]
				: shared;
			const text = wxr((reverse ? items.toReversed() : items).join("\n"));

			let result;
			if (chunked) {
				const prepared = await post(harness, text, "taxonomy");
				const first = await post(harness, text, "content", prepared);
				const second = await post(harness, text, "content", first);
				result = {
					imported: first.result.imported + second.result.imported,
					errors: [...first.result.errors, ...second.result.errors],
				};
			} else {
				result = await importContent(harness, text);
			}
			expect(result.imported).toBe(chunked ? 31 : 2);
			expect(result.errors).toHaveLength(2);
			expect(result.errors.map(({ title }) => title).toSorted()).toEqual([
				"English shared",
				"French shared",
			]);
			for (const error of result.errors)
				expect(error.error).toContain("multiple WordPress entries claim the same source path");

			const rows = await harness.db
				.selectFrom("ec_pages")
				.select(["title", "locale"])
				.where("slug", "=", "overview")
				.orderBy("locale")
				.execute();
			expect(rows).toEqual([
				expect.objectContaining({ title: "English shared", locale: "en" }),
				expect.objectContaining({ title: "French shared", locale: "fr" }),
			]);
			expect(await new RedirectRepository(harness.db).findBySource("/overview")).toBeNull();
			if (chunked) {
				expect(await new RedirectRepository(harness.db).findBySource("/filler-2")).not.toBeNull();
				expect(await new RedirectRepository(harness.db).findBySource("/filler-29")).not.toBeNull();
			}

			const before = await harness.db.selectFrom("ec_pages").selectAll().execute();
			const prepared = await post(harness, text, "taxonomy");
			let chunk = await post(harness, text, "content", prepared);
			const results = [chunk.result];
			while (!chunk.done) {
				chunk = await post(harness, text, "content", chunk);
				results.push(chunk.result);
			}
			const rerun = {
				imported: results.reduce((sum, chunkResult) => sum + chunkResult.imported, 0),
				skipped: results.reduce((sum, chunkResult) => sum + chunkResult.skipped, 0),
				errors: results.flatMap((chunkResult) => chunkResult.errors),
			};
			expect(rerun).toMatchObject({ imported: 0, skipped: chunked ? 31 : 2 });
			expect(rerun.errors).toHaveLength(2);
			expect(
				rerun.errors.every(({ error }) =>
					error.includes("multiple WordPress entries claim the same source path"),
				),
			).toBe(true);
			expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
			expect(await new RedirectRepository(harness.db).findBySource("/overview")).toBeNull();
		},
	);

	it("does not let an unsafe source claim reserve a legitimate pathname", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
		_resetAstroI18nCacheForTests();
		const text = wxr(
			item({ id: 1, title: "English", localeMeta: "en", link: "/overview/" }) +
				item({ id: 2, title: "Unsafe", localeMeta: "fr", link: "/parent/%252e%252e/overview/" }),
		);
		expect(await importContent(harness, text)).toMatchObject({
			imported: 2,
			skipped: 0,
			errors: [{ title: "Unsafe", error: "Could not create redirect: unsafe permalink path" }],
		});
		expect(await redirects(harness)).toEqual([
			{ source: "/overview", destination: "/en/pages/overview" },
		]);
	});

	it("handles a long run of slashes in a full import link", async () => {
		const source = `/old/${"/".repeat(50_000)}tail`;
		const result = await importContent(
			harness,
			wxr(item({ id: 1, title: "Long", link: `${source}/` })),
		);
		expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [] });
		expect(await new RedirectRepository(harness.db).findBySource(source)).toMatchObject({
			destination: "/pages/overview",
		});
	});

	it("keeps created and skipped data when redirect locale verification fails", async () => {
		const checkedDb = harness.db.withPlugin({
			transformQuery(args) {
				const sql = harness.db.getExecutor().compileQuery(args.node, args.queryId).sql;
				if (sql.includes("SELECT DISTINCT locale") && sql.includes('"ec_pages"'))
					throw new Error("locale read unavailable");
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		const faulted = { ...harness, emdash: { ...harness.emdash, db: checkedDb } };
		const text = wxr(item({ id: 1, title: "French", link: "/fr/overview/", localeMeta: "fr" }));
		const errors = [
			{ title: "French", error: "Could not verify redirect ownership; retry with skip existing" },
		];
		expect(await importContent(faulted, text)).toMatchObject({ imported: 1, skipped: 0, errors });
		const before = await harness.db.selectFrom("ec_pages").selectAll().execute();
		expect(before).toHaveLength(1);
		expect(await redirects(harness)).toEqual([]);
		expect(await importContent(faulted, text)).toMatchObject({ imported: 0, skipped: 1, errors });
		expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
		expect(await redirects(harness)).toEqual([]);
	});

	it("keeps same-slug translations distinct and prefixes their redirect targets", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
		_resetAstroI18nCacheForTests();
		const text = wxr(
			item({
				id: 1,
				title: "English",
				link: "/en/first/overview/",
				localeMeta: "en",
				translationGroup: 42,
			}) +
				item({
					id: 2,
					title: "French",
					link: "/fr/second/overview/",
					localeMeta: "fr",
					translationGroup: 42,
				}),
		);
		const result = await importContent(harness, text);
		expect(result).toMatchObject({ imported: 2, skipped: 0, errors: [] });
		expect(
			await harness.db
				.selectFrom("ec_pages")
				.select(["slug", "locale"])
				.orderBy("locale")
				.execute(),
		).toEqual([
			{ slug: "overview", locale: "en" },
			{ slug: "overview", locale: "fr" },
		]);
		expect(await redirects(harness)).toEqual([
			{ source: "/en/first/overview", destination: "/en/pages/overview" },
			{ source: "/fr/second/overview", destination: "/fr/pages/overview" },
		]);
	});
});
