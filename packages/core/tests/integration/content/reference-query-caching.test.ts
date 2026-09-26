/**
 * Reference pages inside the entry's cached snapshot.
 *
 * `getEmDashEntry(..., { references })` resolves its pages while the entry's
 * object-cache snapshot is being built, so a warm hit serves the children
 * without re-reading them. That only holds together if three things are true at
 * once: the selection is part of the cache key, the targets' namespaces are part
 * of the snapshot's dependencies, and the route cache hint names every child row
 * the render read. Each test below pins one of them.
 *
 * The object cache is dialect-independent, so these run against sqlite only;
 * `reference-public-query.test.ts` covers the resolution itself on both.
 */

import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleContentCreate, handleContentUpdate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { getEmDashEntry } from "../../../src/query.js";
import { getReferenceFieldMap } from "../../../src/references/field-map.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveEntry } from "astro:content";

function spyBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(store.get(key) ?? null),
		set: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			store.delete(key);
			return Promise.resolve();
		},
	};
}

/** Let the cache's fire-and-forget write land before the next read. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("reference pages in the entry cache", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();

		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		await new RelationRepository(db).create({
			slug: "posts_related_pages",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Related pages",
		});
		await registry.createField("posts", {
			slug: "related_pages",
			label: "Related pages",
			type: "reference",
			validation: {
				relation: "posts_related_pages",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		runtime = createTestRuntime(db);
		__setObjectCacheBackendForTests(spyBackend(), { revalidate: 1000, defaultTtl: 3600 });
		vi.mocked(getLiveEntry).mockReset();
	});

	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
		vi.mocked(getLiveEntry).mockReset();
	});

	async function createPage(title: string) {
		const slug = title.toLowerCase().replaceAll(" ", "-");
		const result = await handleContentCreate(db, "pages", { data: { title }, slug });
		if (!result.success) throw new Error(`Page setup failed: ${result.error.message}`);
		const published = await runtime.handleContentPublish("pages", result.data.item.id);
		if (!published.success) throw new Error("Page publish failed");
		return result.data.item;
	}

	async function createPost(title: string, pageIds: string[]) {
		const created = await runtime.handleContentCreate("posts", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			references: { related_pages: pageIds },
		});
		if (!created.success || !created.data) throw new Error("Post setup failed");
		const published = await runtime.handleContentPublish("posts", created.data.item.id);
		if (!published.success) throw new Error("Post publish failed");
		return created.data.item;
	}

	/** Point the mocked loader at a published post, the way an anonymous render resolves one. */
	async function mockPost(post: { id: string; slug: string }): Promise<void> {
		const row = await new ContentRepository(db).findById("posts", post.id);
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: {
				id: post.slug,
				data: {
					id: post.id,
					slug: post.slug,
					title: "Hello",
					status: "published",
					locale: "en",
					translationGroup: row?.translationGroup,
				},
			},
			cacheHint: { tags: [post.id] },
		});
	}

	/** Rename a row behind the cache's back, so a stale read is visible as the old title. */
	async function renameBehindTheCache(collection: string, id: string, title: string) {
		await sql`UPDATE ${sql.ref(`ec_${collection}`)} SET title = ${title} WHERE id = ${id}`.execute(
			db,
		);
	}

	function read(slug: string, references?: Record<string, true | { limit?: number }>) {
		return runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("posts", slug, references ? { references } : undefined),
		);
	}

	it("serves the reference pages from the warm snapshot", async () => {
		const page = await createPage("Page One");
		const post = await createPost("Hello", [page.id]);
		await mockPost(post);

		await read(post.slug, { related_pages: true });
		await flush();
		await renameBehindTheCache("pages", page.id, "Renamed");

		const warm = await read(post.slug, { related_pages: true });
		const child = warm.entry?.references?.related_pages?.entries[0];
		expect(child?.data.title).toBe("Page One");
		// The snapshot round-trips a child's dates as Dates, not ISO strings.
		expect(child?.data.createdAt).toBeInstanceOf(Date);
	});

	it("does not serve a reference-less snapshot to a caller that asked for references", async () => {
		const page = await createPage("Page One");
		const post = await createPost("Hello", [page.id]);
		await mockPost(post);

		await read(post.slug);
		await flush();

		const withRefs = await read(post.slug, { related_pages: true });
		expect(
			withRefs.entry?.references?.related_pages?.entries.map((entry) => entry.data.title),
		).toEqual(["Page One"]);
	});

	it("keys the snapshot on the selection, so a wider page is not served a narrower one", async () => {
		const first = await createPage("Page One");
		const second = await createPage("Page Two");
		const post = await createPost("Hello", [first.id, second.id]);
		await mockPost(post);

		const narrow = await read(post.slug, { related_pages: { limit: 1 } });
		expect(narrow.entry?.references?.related_pages?.entries).toHaveLength(1);
		await flush();

		const wide = await read(post.slug, { related_pages: { limit: 5 } });
		expect(wide.entry?.references?.related_pages?.entries).toHaveLength(2);
	});

	it("drops the cached snapshot when a referenced entry is written", async () => {
		const page = await createPage("Page One");
		const post = await createPost("Hello", [page.id]);
		await mockPost(post);

		await read(post.slug, { related_pages: true });
		await flush();

		const updated = await runtime.handleContentUpdate("pages", page.id, {
			data: { title: "Renamed" },
		});
		if (!updated.success) throw new Error("Page update failed");
		const republished = await runtime.handleContentPublish("pages", page.id);
		if (!republished.success) throw new Error("Page republish failed");
		await flush();

		const after = await read(post.slug, { related_pages: true });
		expect(after.entry?.references?.related_pages?.entries[0]?.data.title).toBe("Renamed");
	});

	it("drops the cached snapshot when only the selection changes", async () => {
		const first = await createPage("Page One");
		const second = await createPage("Page Two");
		const post = await createPost("Hello", [first.id]);
		await mockPost(post);

		await read(post.slug, { related_pages: true });
		await flush();

		// A picker-only write: no column on the entry changes, so nothing but the
		// links tells the cache that the render's answer has moved.
		const updated = await handleContentUpdate(db, "posts", post.id, {
			references: { related_pages: [second.id] },
		});
		if (!updated.success) throw new Error(`Post update failed: ${updated.error.message}`);
		await flush();

		const after = await read(post.slug, { related_pages: true });
		expect(after.entry?.references?.related_pages?.entries.map((e) => e.data.title)).toEqual([
			"Page Two",
		]);
	});

	it("names every child row in the cache hint", async () => {
		const first = await createPage("Page One");
		const second = await createPage("Page Two");
		const post = await createPost("Hello", [first.id, second.id]);
		await mockPost(post);

		const result = await read(post.slug, { related_pages: true });

		expect(result.cacheHint.tags).toEqual(expect.arrayContaining([post.id, first.id, second.id]));
		// The newest of parent and children, so a child write moves the header.
		const repo = new ContentRepository(db);
		const stamps = await Promise.all(
			[first.id, second.id].map(async (id) => {
				const row = await repo.findById("pages", id);
				return new Date(row!.updatedAt!).getTime();
			}),
		);
		expect(result.cacheHint.lastModified?.getTime()).toBe(Math.max(...stamps));
	});

	it("stops serving a deleted reference field from the cached field map", async () => {
		const { handleSchemaFieldDelete } = await import("../../../src/api/handlers/schema.js");

		const warm = await runWithContext({ editMode: false, db }, () => getReferenceFieldMap("posts"));
		expect(warm.has("related_pages")).toBe(true);
		await flush();

		const deleted = await handleSchemaFieldDelete(db, "posts", "related_pages");
		expect(deleted.success).toBe(true);

		const after = await runWithContext({ editMode: false, db }, () =>
			getReferenceFieldMap("posts"),
		);
		expect(after.has("related_pages")).toBe(false);
	});
});
