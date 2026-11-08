import { afterEach, beforeEach, expect, it } from "vitest";

import { POST as executePost } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
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
	parent,
	localeMeta,
	translationGroup,
	category = false,
}: {
	id: number;
	title: string;
	slug?: string;
	link?: string;
	parent?: number;
	localeMeta?: string;
	translationGroup?: number;
	category?: boolean;
}) {
	return `<item>
		<title>${title}</title>
		<wp:post_id>${id}</wp:post_id>
		<wp:post_type>page</wp:post_type>
		<wp:status>publish</wp:status>
		<wp:post_name>${slug}</wp:post_name>
		${parent === undefined ? "" : `<wp:post_parent>${parent}</wp:post_parent>`}
		${link ? `<link>https://example.test${link}</link>` : ""}
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
) {
	const body = new FormData();
	body.append("file", new File([text], "test.xml", { type: "text/xml" }));
	body.append(
		"config",
		JSON.stringify({
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting,
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
) {
	const response = await executePost({
		request: new Request("http://localhost/_emdash/api/import/wordpress/execute", {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
			body: formData(text, phase, data, skipExisting),
		}),
		locals: { emdash: harness.emdash, user: { id: "test-admin", role: 50 } },
	} as any);
	expect(response.status).toBe(200);
	return (await response.json()).data;
}

async function importContent(harness: Harness, text: string, skipExisting = true) {
	const prepared = await post(harness, text, "taxonomy", undefined, skipExisting);
	return (await post(harness, text, "content", prepared, skipExisting)).result;
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

	it("does not bind an explicitly different language to an existing i18n-off entry", async () => {
		const english = wxr(
			item({ id: 1, title: "English", link: "/first/overview/", localeMeta: "en" }),
		);
		expect(await importContent(harness, english)).toMatchObject({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		const before = await harness.db.selectFrom("ec_pages").selectAll().execute();
		const french = wxr(item({ id: 2, title: "French", link: "/fr/overview/", localeMeta: "fr" }));
		expect(await importContent(harness, french)).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [
				{
					title: "French",
					error:
						"Skipped item matches an entry in another locale while i18n is disabled; no permalink redirect was created",
				},
			],
		});
		expect(await harness.db.selectFrom("ec_pages").selectAll().execute()).toEqual(before);
		expect(await redirects(harness)).toEqual([
			{ source: "/first/overview", destination: "/pages/overview" },
		]);
	});

	it("reports same-slug languages as ambiguous in the shared i18n-off route space", async () => {
		const text = wxr(
			item({ id: 1, title: "First", link: "/en/first/overview/", localeMeta: "en" }) +
				item({ id: 2, title: "Second", link: "/fr/second/overview/", localeMeta: "fr" }),
		);
		expect(await importContent(harness, text)).toMatchObject({
			imported: 1,
			skipped: 1,
			errors: [{ title: "Second", error: AMBIGUOUS }],
		});
		expect(await harness.db.selectFrom("ec_pages").select(["slug", "locale"]).execute()).toEqual([
			{ slug: "overview", locale: "en" },
		]);
		expect(await redirects(harness)).toEqual([
			{ source: "/en/first/overview", destination: "/pages/overview" },
		]);
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
