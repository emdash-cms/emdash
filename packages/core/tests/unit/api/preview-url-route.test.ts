import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate, handleContentGet } from "../../../src/api/index.js";
import { POST as previewUrl } from "../../../src/astro/routes/api/content/[collection]/[id]/preview-url.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * Regression: the preview-url endpoint used a hard-coded `/{collection}/{id}`
 * default, ignoring the collection's configured `url_pattern`. On any site
 * whose content is served at a custom permalink (e.g. `/blog/{slug}`) the
 * admin "Preview" button produced a link that 404'd. The sitemap and
 * "View published" links already resolve the same `url_pattern`; the preview
 * link must too. See discussion #1525 / PR #1526.
 */
describe("preview-url route — respects collection url_pattern", () => {
	let db: Kysely<Database>;

	const call = async (collection: string, id: string, body: Record<string, unknown> = {}) => {
		const request = new Request(
			`http://localhost/_emdash/api/content/${collection}/${id}/preview-url`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		const response = await previewUrl({
			params: { collection, id },
			request,
			locals: {
				emdash: {
					db,
					handleContentGet: (c: string, i: string) => handleContentGet(db, c, i),
				},
				user: { id: "u1", role: Role.ADMIN },
			},
		} as unknown as Parameters<typeof previewUrl>[0]);
		return response;
	};

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("resolves the configured url_pattern into the preview link", async () => {
		await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/blog/{slug}" });
		const created = await handleContentCreate(db, "post", {
			data: { title: "Hello World" },
		});
		const id = created.data!.item.id;

		const response = await call("post", id);
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith("/blog/hello-world?_preview=")).toBe(true);
		// The generic collection/id fallback must NOT leak through.
		expect(url.startsWith("/post/")).toBe(false);
	});

	it("falls back to /{collection}/{id} when no url_pattern is configured", async () => {
		const created = await handleContentCreate(db, "post", {
			data: { title: "No Pattern" },
		});
		const id = created.data!.item.id;

		const response = await call("post", id);
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith(`/post/${id}?_preview=`)).toBe(true);
	});

	it("lets an explicit pathPattern override the url_pattern", async () => {
		await new SchemaRegistry(db).updateCollection("post", { urlPattern: "/blog/{slug}" });
		const created = await handleContentCreate(db, "post", {
			data: { title: "Override Me" },
		});
		const id = created.data!.item.id;

		const response = await call("post", id, { pathPattern: "/custom/{id}" });
		expect(response.status).toBe(200);
		const { url } = (await response.json()).data as { url: string };

		expect(url.startsWith(`/custom/${id}?_preview=`)).toBe(true);
	});
});
