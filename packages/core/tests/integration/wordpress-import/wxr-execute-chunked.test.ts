/**
 * Regression coverage for issue #3210: WXR execute supports chunked importing
 * so large WXR files stay under the D1 per-invocation query budget.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as executePost } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { handlersFromRuntime, createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";
import type { Harness } from "./wxr-i18n-taxonomies.test.js";

async function setup(): Promise<Harness> {
	const db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);

	await registry.createCollection({
		slug: "post",
		label: "Posts",
		labelSingular: "Post",
	});
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });
	await registry.createField("post", {
		slug: "content",
		label: "Content",
		type: "portableText",
	});
	await registry.createField("post", { slug: "excerpt", label: "Excerpt", type: "text" });

	await db
		.updateTable("_emdash_taxonomy_def_groups")
		.set({ collections: JSON.stringify(["post"]) })
		.where("name", "in", ["category", "tag"])
		.execute();

	const runtime = createTestRuntime(db);
	const emdash = handlersFromRuntime(runtime);
	const manifest = await emdash.getManifest();
	return { db, emdash, manifest };
}

function makeWxr(postCount: number): string {
	const items = Array.from({ length: postCount }, (_, i) => {
		const n = i + 1;
		return `	<item>
			<title>Post ${n}</title>
			<wp:post_id>${n}</wp:post_id>
			<wp:post_type>post</wp:post_type>
			<wp:status>publish</wp:status>
			<wp:post_name>post-${n}</wp:post_name>
			<wp:post_date>2024-01-01 12:00:00</wp:post_date>
			<wp:post_date_gmt>2024-01-01 12:00:00</wp:post_date_gmt>
			<content:encoded><![CDATA[<p>Content ${n}</p>]]></content:encoded>
		</item>`;
	}).join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
	<channel>
		<title>Test Site</title>
		<link>https://example.com</link>
		${items}
	</channel>
</rss>`;
}

function buildFormData(
	wxrText: string,
	extra: { phase?: string; cursor?: string; chunk?: string } = {},
): FormData {
	const formData = new FormData();
	formData.append("file", new File([wxrText], "test.xml", { type: "text/xml" }));
	formData.append(
		"config",
		JSON.stringify({
			postTypeMappings: { post: { collection: "post", enabled: true } },
			skipExisting: false,
		}),
	);
	if (extra.phase) formData.append("phase", extra.phase);
	if (extra.cursor) formData.append("cursor", extra.cursor);
	if (extra.chunk) formData.append("chunk", extra.chunk);
	return formData;
}

function buildContext(formData: FormData, emdash: Harness["emdash"]) {
	return {
		request: new Request("http://localhost/_emdash/api/import/wordpress/execute", {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
			body: formData,
		}),
		locals: { emdash, user: { id: "test-admin", role: 50 } },
	};
}

describe("WXR execute chunked import (#3210)", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await setup();
	});

	afterEach(async () => {
		await teardownTestDatabase(harness.db);
	});

	it("processes a large WXR in bounded chunks across multiple invocations", async () => {
		const wxr = makeWxr(35);

		// First chunk
		const firstResponse = await executePost(
			// eslint-disable-next-line typescript/no-unsafe-type-assertion
			buildContext(buildFormData(wxr, { phase: "content" }), harness.emdash) as any,
		);
		expect(firstResponse.status).toBe(200);
		const first = await firstResponse.json();
		expect(first.data.result.imported).toBe(30);
		expect(first.data.done).toBe(false);
		expect(first.data.cursor).toEqual({ offset: 30 });

		// Second chunk
		const secondResponse = await executePost(
			// eslint-disable-next-line typescript/no-unsafe-type-assertion
			buildContext(
				buildFormData(wxr, {
					phase: "content",
					cursor: JSON.stringify(first.data.cursor),
					chunk: JSON.stringify(first.data.chunk),
				}),
				harness.emdash,
			) as any,
		);
		expect(secondResponse.status).toBe(200);
		const second = await secondResponse.json();
		expect(second.data.result.imported).toBe(5);
		expect(second.data.done).toBe(true);
		expect(second.data.cursor).toBeUndefined();

		// Verify the DB
		const rows = await harness.db.selectFrom("ec_post").select("id").execute();
		expect(rows.length).toBe(35);
	});

	it("rejects single-shot imports that exceed the per-invocation budget", async () => {
		const wxr = makeWxr(35);
		const response = await executePost(
			// eslint-disable-next-line typescript/no-unsafe-type-assertion
			buildContext(buildFormData(wxr), harness.emdash) as any,
		);
		expect(response.status).toBe(413);
		const body = await response.json();
		expect(body.error.code).toBe("WXR_IMPORT_TOO_LARGE");
	});
});
