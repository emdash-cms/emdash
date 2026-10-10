import type { CollectionSchemaInfo } from "emdash";
import { describe, expect, it } from "vitest";

import { failureOf, Indexer } from "../src/indexer.js";
import { FakeItems } from "./fake-ai-search.js";
import { byline, config, entry, fakeEmDash, taxonomy, term } from "./fakes.js";

function setup(records: Parameters<typeof fakeEmDash>[0], overrides = {}, warmingUp = false) {
	const items = new FakeItems();
	const indexer = new Indexer(
		{ ...fakeEmDash(records), items, warmingUp: async () => warmingUp },
		config(overrides),
	);
	return { items, indexer };
}

/** Snapshots a source's items, syncs its records, and sweeps the rest, as a build does. */
async function buildSource(indexer: Indexer, source: string) {
	let page: number | undefined = 1;
	while (page) ({ next: page } = await indexer.snapshotPage(source, page));
	let synced = 0;
	let uploaded = 0;
	let cursor: string | undefined;
	do {
		const result = await indexer.syncPage(source, cursor);
		synced += result.synced.length;
		uploaded += result.uploaded;
		cursor = result.cursor;
	} while (cursor);
	for (;;) {
		const sweep = await indexer.sweepPage(source);
		synced += sweep.synced.length;
		uploaded += sweep.uploaded;
		if (sweep.done) return { synced, uploaded };
	}
}

describe("Indexer", () => {
	it("indexes a published entry with its public URL, title, and author names", async () => {
		const post = entry();
		const { items, indexer } = setup({ entries: [post], bylines: [byline()] });

		await indexer.syncRecord("posts", post.id);

		const item = items.items.get("posts/entry-1.md");
		expect(item?.metadata).toMatchObject({
			source: "posts",
			locale: "en",
			priority: "3",
			title: "Hello world",
			url: "/posts/hello-world",
		});
		expect(item?.body).toContain("Body text");
		expect(item?.body).toContain("Authors: Jane Doe");
	});

	it("does not upload an entry again when its document is unchanged", async () => {
		const post = entry();
		const { items, indexer } = setup({ entries: [post] });

		await indexer.syncRecord("posts", post.id);
		await indexer.syncRecord("posts", post.id);

		expect(items.uploads).toBe(1);
	});

	it("drops a deleted author's name when the collection is synced again", async () => {
		const post = entry();
		const bylines = [byline()];
		const { items, indexer } = setup({ entries: [post], bylines });
		await buildSource(indexer, "posts");

		bylines.length = 0;
		await buildSource(indexer, "posts");

		expect(items.uploads).toBe(2);
		expect(items.items.get("posts/entry-1.md")?.body).not.toContain("Jane Doe");
	});

	it("uploads again when AI Search failed to index the previous upload", async () => {
		const post = entry();
		const { items, indexer } = setup({ entries: [post] });

		await indexer.syncRecord("posts", post.id);
		const indexed = items.items.get("posts/entry-1.md");
		if (indexed) indexed.status = "error";
		await indexer.syncRecord("posts", post.id);

		expect(items.uploads).toBe(2);
	});

	it("does not index entries of a disabled collection", async () => {
		const post = entry();
		const { items, indexer } = setup(
			{ entries: [post] },
			{ sources: { posts: { enabled: false, fields: ["title"], weight: 3 } } },
		);

		await indexer.syncRecord("posts", post.id);

		expect(items.items.size).toBe(0);
	});

	it("removes a collection's items once it is disabled", async () => {
		const items = new FakeItems();
		const deps = {
			...fakeEmDash({ entries: [entry(), entry({ id: "entry-2", slug: "b" })] }),
			items,
		};
		await buildSource(new Indexer(deps, config()), "posts");

		const disabled = config({
			sources: { posts: { enabled: false, fields: ["title"], weight: 3 } },
		});
		const build = await buildSource(new Indexer(deps, disabled), "posts");

		expect(items.items.size).toBe(0);
		expect(build).toEqual({ synced: 2, uploaded: 0 });
	});

	it("leaves author names out when post context is off", async () => {
		const post = entry();
		const { items, indexer } = setup(
			{ entries: [post], bylines: [byline()] },
			{ sources: { posts: { ...config().sources.posts!, includeAuthorNames: false } } },
		);

		await indexer.syncRecord("posts", post.id);

		expect(items.items.get("posts/entry-1.md")?.body).not.toContain("Jane Doe");
	});

	it("adds the entry's terms from included taxonomies, in the entry's locale", async () => {
		const post = entry({ locale: "fr" });
		const { items, indexer } = setup({
			entries: [post],
			taxonomies: [taxonomy(), taxonomy({ name: "category", label: "Categories" })],
			terms: [
				term({ label: "Gardening" }),
				term({ id: "term-1-fr", label: "Jardinage", locale: "fr" }),
				term({ id: "term-2", translationGroup: "term-2", label: "Compost" }),
				term({ id: "term-3", taxonomy: "category", label: "Internal" }),
			],
		});

		await indexer.syncRecord("posts", post.id);

		const body = items.items.get("posts/entry-1.md")?.body;
		expect(body).toContain("Tags: Compost, Jardinage");
		expect(body).not.toContain("Internal");
	});

	it("uploads again when an entry's terms change", async () => {
		const post = entry();
		const terms = [term()];
		const { items, indexer } = setup({ entries: [post], taxonomies: [taxonomy()], terms });

		await indexer.syncRecord("posts", post.id);
		terms.push(term({ id: "term-2", translationGroup: "term-2", label: "Compost" }));
		await indexer.syncRecord("posts", post.id);

		expect(items.uploads).toBe(2);
		expect(items.items.get("posts/entry-1.md")?.body).toContain("Tags: Compost, Gardening");
	});

	it("indexes an author profile at its address template", async () => {
		const author = byline();
		const { items, indexer } = setup({ bylines: [author] });

		await indexer.syncRecord("_authors", author.id);

		expect(items.items.get("_authors/byline-1.md")?.metadata).toMatchObject({
			source: "_authors",
			title: "Jane Doe",
			url: "/authors/jane-doe",
		});
	});

	it("uses the collection's first image field as the preview image", async () => {
		const collection = {
			slug: "posts",
			titleField: "title",
			fields: [{ slug: "cover", type: "image" }],
		} as CollectionSchemaInfo;
		const local = entry({
			data: {
				title: "Local",
				cover: { provider: "local", id: "01", meta: { storageKey: "01ABC.jpg" } },
			},
		});
		const remote = entry({
			id: "entry-2",
			slug: "remote",
			data: { title: "Remote", cover: { provider: "x", src: "https://cdn.example/a.jpg" } },
		});
		const unsafe = entry({
			id: "entry-3",
			slug: "unsafe",
			data: { title: "Unsafe", cover: { provider: "x", src: "javascript:alert(1)" } },
		});
		const { items, indexer } = setup({
			entries: [local, remote, unsafe],
			collections: [collection],
		});

		await buildSource(indexer, "posts");

		const image = (id: string) => items.items.get(`posts/${id}.md`)?.metadata?.image;
		expect(image("entry-1")).toBe("/_emdash/api/media/file/01ABC.jpg");
		expect(image("entry-2")).toBe("https://cdn.example/a.jpg");
		expect(image("entry-3")).toBeUndefined();
	});

	it("uses an author's avatar as the preview image", async () => {
		const author = byline({ avatarMediaId: "avatar-1" });
		const avatar = {
			id: "avatar-1",
			filename: "jane.jpg",
			mimeType: "image/jpeg",
			size: 1,
			url: "/_emdash/api/media/file/jane.jpg",
			createdAt: "",
		};
		const { items, indexer } = setup({ bylines: [author], media: [avatar] });

		await indexer.syncRecord("_authors", author.id);

		expect(items.items.get("_authors/byline-1.md")?.metadata?.image).toBe(avatar.url);
	});

	it("checks a build's records against one snapshot instead of looking each one up", async () => {
		const entries = Array.from({ length: 120 }, (_, i) =>
			entry({ id: `entry-${i}`, slug: `s-${i}` }),
		);
		const { items, indexer } = setup({ entries });
		await buildSource(indexer, "posts");
		items.lists = 0;

		const build = await buildSource(indexer, "posts");

		expect(build.synced).toBe(120);
		expect(items.uploads).toBe(120);
		expect(items.lists).toBe(3);
	});

	it("counts only the records a build uploads, not unchanged or removed ones", async () => {
		const posts = [entry({ id: "a", slug: "a" }), entry({ id: "b", slug: "b" })];
		const { indexer } = setup({ entries: posts });

		const first = await buildSource(indexer, "posts");
		(posts[0] as { status: string }).status = "draft";
		const second = await buildSource(indexer, "posts");

		expect(first.uploaded).toBe(2);
		expect(second).toEqual({ synced: 2, uploaded: 0 });
	});

	it("removes the items of records that stopped being published, even when their hook was missed", async () => {
		const entries = Array.from({ length: 120 }, (_, i) =>
			entry({ id: `entry-${i}`, slug: `s-${i}` }),
		);
		const { items, indexer } = setup({ entries });
		await buildSource(indexer, "posts");

		for (const stale of entries.slice(0, 110)) stale.status = "draft";
		await buildSource(indexer, "posts");

		expect(items.items.size).toBe(10);
		expect(items.items.has("posts/entry-119.md")).toBe(true);
	});

	it("removes the items of a collection that no longer exists", async () => {
		const items = new FakeItems();
		const deps = { ...fakeEmDash({ entries: [entry()] }), items };
		await buildSource(new Indexer(deps, config()), "posts");

		const withoutPosts = { ...deps, schema: { getCollection: async () => null } };
		await buildSource(new Indexer(withoutPosts, config()), "posts");

		expect(items.items.size).toBe(0);
	});

	it("uploads again an item removed from AI Search since the previous build", async () => {
		const post = entry();
		const { items, indexer } = setup({ entries: [post] });
		await buildSource(indexer, "posts");

		items.items.clear();
		await buildSource(indexer, "posts");

		expect(items.uploads).toBe(2);
		expect(items.items.has("posts/entry-1.md")).toBe(true);
	});

	it("keeps syncing the rest of a page when one record fails", async () => {
		const { items, indexer } = setup({
			entries: [
				entry(),
				entry({ id: "entry-2", slug: "second" }),
				entry({ id: "entry-3", slug: "third" }),
			],
		});
		items.failKeys.add("posts/entry-2.md");

		const page = await indexer.syncPage("posts", undefined);

		expect(page).toMatchObject({
			synced: ["entry-1", "entry-3"],
			failures: [{ id: "entry-2", error: "AiSearchError: internal_error" }],
		});
		expect([...items.items.keys()].toSorted()).toEqual(["posts/entry-1.md", "posts/entry-3.md"]);
	});

	it("reports the older item AI Search still holds for a record whose upload failed", async () => {
		const posts = [entry(), entry({ id: "entry-2", slug: "second" })];
		const { items, indexer } = setup({ entries: posts });
		await buildSource(indexer, "posts");
		for (const post of posts) post.data = { title: "Changed" };
		items.failKeys.add("posts/entry-1.md");
		await indexer.snapshotPage("posts", 1);

		const page = await indexer.syncPage("posts", undefined);
		const failure = await indexer.syncRecord("posts", "entry-1").catch(failureOf);

		expect(page.failures).toEqual([
			{ id: "entry-1", error: "AiSearchError: internal_error", leftover: "indexed" },
		]);
		expect(failure).toEqual({ error: "AiSearchError: internal_error", leftover: "indexed" });
	});

	it("stops starting new records once AI Search rate-limits", async () => {
		const entries = Array.from({ length: 30 }, (_, i) =>
			entry({ id: `entry-${i}`, slug: `s-${i}` }),
		);
		const { items, indexer } = setup({ entries });
		items.rateLimitAfter = 3;

		const page = await indexer.syncPage("posts", undefined);

		expect(page.backOff).toBe(true);
		expect(page.synced).toHaveLength(3);
		expect(page.failures).toEqual([]);
	});

	it("does not upload unchanged records again when retrying a rate-limited page", async () => {
		const entries = Array.from({ length: 4 }, (_, i) =>
			entry({ id: `entry-${i}`, slug: `s-${i}` }),
		);
		const { items, indexer } = setup({ entries });
		await buildSource(indexer, "posts");
		for (const changed of entries.slice(0, 2)) changed.data = { title: "Changed" };
		await indexer.snapshotPage("posts", 1);

		items.rateLimitAfter = items.uploads + 1;
		const limited = await indexer.syncPage("posts", undefined);
		items.rateLimitAfter = Number.POSITIVE_INFINITY;
		const retried = await indexer.syncPage("posts", undefined);

		expect(limited.backOff).toBe(true);
		expect(retried).toMatchObject({ uploaded: 2, backOff: false });
		expect((await indexer.sweepPage("posts")).done).toBe(true);
		expect(items.items.size).toBe(4);
	});

	it("backs off instead of failing records while a new instance is starting", async () => {
		const { items, indexer } = setup({ entries: [entry()] }, {}, true);
		items.starting = true;

		const starting = await indexer.syncPage("posts", undefined);
		expect(starting).toMatchObject({ synced: [], failures: [], backOff: true });
		expect(await indexer.snapshotPage("posts", 1)).toEqual({ backOff: true });

		items.starting = false;
		expect(await indexer.syncPage("posts", undefined)).toMatchObject({
			synced: ["entry-1"],
			backOff: false,
		});
	});

	it("fails records when the instance is missing once it should have started", async () => {
		const { items, indexer } = setup({ entries: [entry()] });
		items.starting = true;

		const page = await indexer.syncPage("posts", undefined);

		expect(page).toMatchObject({
			synced: [],
			backOff: false,
			failures: [{ id: "entry-1", error: "AiSearchNotFoundError: ai_search_not_found" }],
		});
	});

	it("throws when a single record is rate-limited, so the caller can retry it", async () => {
		const post = entry();
		const { items, indexer } = setup({ entries: [post] });
		items.rateLimitAfter = 0;

		await expect(indexer.syncRecord("posts", post.id)).rejects.toThrow(/rate limit/);
	});

	it("syncs an author profile by id, and removes it once the author is deleted", async () => {
		const records = { bylines: [byline()] };
		const { items, indexer } = setup(records);

		await indexer.syncRecord("_authors", "byline-1");
		const indexed = items.items.has("_authors/byline-1.md");
		records.bylines.pop();
		await indexer.syncRecord("_authors", "byline-1");

		expect(indexed).toBe(true);
		expect(items.items.size).toBe(0);
	});
});
