import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetEnvCache } from "../../../src/api/public-url.js";
import { POST as executePost } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { handlersFromRuntime, createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

async function setup() {
	const db = await setupTestDatabase();
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
	return { db, runtime, emdash: handlersFromRuntime(runtime) };
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

describe("WordPress permalink roots and publish cleanup", () => {
	let harness: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		harness = await setup();
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		_resetEnvCache();
		await teardownTestDatabase(harness.db);
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
		{ base: "/", source: "/contact/", destination: "/posts/contact" },
		{ base: "/archive/", source: "/archive/contact/", destination: "/archive/posts/contact" },
	])(
		"removes the imported redirect when a page is published at the canonical path ($base)",
		async ({ base, source, destination }) => {
			if (base !== "/") vi.stubEnv("BASE_URL", base);
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
});
