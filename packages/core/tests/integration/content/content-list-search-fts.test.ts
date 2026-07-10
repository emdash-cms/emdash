/**
 * FTS-backed admin content-list search (#1517).
 *
 * When a collection has search enabled, the list filter's `q` is served from
 * the FTS5 index (token-prefix MATCH plus an index-served slug GLOB prefix)
 * instead of the full-scan `lower(col) LIKE '%term%'`. These tests pin the
 * user-visible behavior of that path — matching, count parity, literal
 * treatment of FTS metacharacters — and the fallback when the display
 * columns aren't covered by the index.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleContentCreate, handleContentList } from "../../../src/api/handlers/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type Db = Awaited<ReturnType<typeof setupTestDatabase>>;

async function seedPosts(db: Db) {
	for (let i = 0; i < 30; i++) {
		const created = await handleContentCreate(db, "posts", {
			slug: `post-${String(i).padStart(3, "0")}`,
			data: { title: `Ordinary Post ${i}` },
		});
		if (!created.success) throw new Error("seed failed");
	}
	const needle = await handleContentCreate(db, "posts", {
		slug: "the-needle-post",
		data: { title: "zzz Needle Headline" },
	});
	if (!needle.success) throw new Error("needle seed failed");

	const quoted = await handleContentCreate(db, "posts", {
		slug: "quoted-post",
		data: { title: 'He said "quoted" loudly' },
	});
	if (!quoted.success) throw new Error("quoted seed failed");
}

function titlesOf(result: {
	success: boolean;
	data?: { items: { data: Record<string, unknown> }[] };
}) {
	if (!result.success || !result.data) throw new Error("list failed");
	return result.data.items.map((i) => i.data.title as string);
}

describe("content list search served by FTS (#1517)", () => {
	let db: Db;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await seedPosts(db);
		await new FTSManager(db).enableSearch("posts");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("finds an entry by title token prefix", async () => {
		const result = await handleContentList(db, "posts", { q: "Needle", limit: 20 });
		expect(titlesOf(result)).toEqual(["zzz Needle Headline"]);
	});

	it("matches case-insensitively", async () => {
		const lower = await handleContentList(db, "posts", { q: "needle", limit: 20 });
		expect(titlesOf(lower)).toContain("zzz Needle Headline");

		const upper = await handleContentList(db, "posts", { q: "NEEDLE", limit: 20 });
		expect(titlesOf(upper)).toContain("zzz Needle Headline");
	});

	it("matches multi-word prefixes across the title", async () => {
		const result = await handleContentList(db, "posts", { q: "need head", limit: 20 });
		expect(titlesOf(result)).toContain("zzz Needle Headline");
	});

	it("finds an entry by slug prefix (slug is not in the FTS index)", async () => {
		const result = await handleContentList(db, "posts", { q: "the-needle", limit: 20 });
		expect(titlesOf(result)).toContain("zzz Needle Headline");
	});

	it("returns a total that matches the filtered set, not the whole table", async () => {
		const result = await handleContentList(db, "posts", { q: "Needle", limit: 20 });
		if (!result.success) throw new Error("list failed");
		expect(result.data.total).toBe(1);
	});

	it("treats double quotes in the query literally instead of erroring", async () => {
		const result = await handleContentList(db, "posts", { q: '"quoted"', limit: 20 });
		if (!result.success) throw new Error(`list failed: ${JSON.stringify(result)}`);
		expect(titlesOf(result)).toContain('He said "quoted" loudly');
	});

	it("treats FTS operators as plain words", async () => {
		// Must not throw and must not match everything.
		const result = await handleContentList(db, "posts", { q: "needle AND", limit: 100 });
		if (!result.success) throw new Error("list failed");
		expect(titlesOf(result)).not.toContain("Ordinary Post 0");
	});

	it("excludes soft-deleted rows (FTS triggers keep the index in sync)", async () => {
		const before = await handleContentList(db, "posts", { q: "Needle", limit: 20 });
		if (!before.success) throw new Error("list failed");
		const needleId = before.data.items[0]?.id;
		if (!needleId) throw new Error("needle not found");

		await db
			.updateTable("ec_posts" as never)
			.set({ deleted_at: new Date().toISOString() } as never)
			.where("id" as never, "=", needleId as never)
			.execute();

		const after = await handleContentList(db, "posts", { q: "Needle", limit: 20 });
		if (!after.success) throw new Error("list failed");
		expect(after.data.items).toHaveLength(0);
		expect(after.data.total).toBe(0);
	});
});

describe("content list search falls back to LIKE when FTS cannot serve it", () => {
	let db: Db;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		// `title` exists but is NOT searchable — the FTS index (over `body`)
		// would miss title matches, so the filter must stay on LIKE.
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await seedPosts(db);
		await new FTSManager(db).enableSearch("posts");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("still finds title matches via the LIKE fallback", async () => {
		// Mid-word substring — only LIKE can match this; proves the handler
		// did not route to FTS despite search being enabled.
		const result = await handleContentList(db, "posts", { q: "eedle", limit: 20 });
		expect(titlesOf(result)).toContain("zzz Needle Headline");
	});
});
