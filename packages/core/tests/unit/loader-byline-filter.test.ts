import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("Loader byline credit filter", (dialectName: DialectName) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let creditSeq = 0;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialectName);
		db = ctx.db;
		creditSeq = 0;
		// Add a 'series' field so we can test byline + field combinations.
		const registry = new SchemaRegistry(db);
		await registry.createField("post", {
			slug: "series",
			label: "Series",
			type: "string",
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPost(title: string, opts: { series?: string } = {}) {
		const result = await handleContentCreate(db, "post", {
			data: { title, series: opts.series ?? null },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	/**
	 * Insert an explicit byline credit. `bylineGroup` is the byline's
	 * translation_group, matching what `_emdash_content_bylines.byline_id`
	 * stores since migration 040.
	 */
	async function credit(contentId: string, bylineGroup: string, sortOrder = 0) {
		await db
			.insertInto("_emdash_content_bylines" as never)
			.values({
				id: `cb_${creditSeq++}`,
				collection_slug: "post",
				content_id: contentId,
				byline_id: bylineGroup,
				sort_order: sortOrder,
			} as never)
			.execute();
	}

	function load(where: Record<string, unknown>) {
		const loader = emdashLoader();
		return runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", where: where as never } }),
		);
	}

	it("returns entries where the byline is the primary credit", async () => {
		const post = await createPost("Solo");
		await credit(post.id, "byline_alice", 0);

		const result = await load({ byline: "byline_alice" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("Solo");
	});

	it("returns co-authored entries where the byline is a secondary credit", async () => {
		// This is the core bug from #1358: filtering on primary_byline_id
		// alone misses entries where the byline is not first.
		const post = await createPost("Co-authored");
		await credit(post.id, "byline_alice", 0);
		await credit(post.id, "byline_bob", 1);

		const result = await load({ byline: "byline_bob" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("Co-authored");
	});

	it("returns only entries credited to the requested byline", async () => {
		const a = await createPost("By Bob");
		const b = await createPost("By Alice");
		await credit(a.id, "byline_bob", 0);
		await credit(b.id, "byline_alice", 0);

		const result = await load({ byline: "byline_bob" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("By Bob");
	});

	it("matches any of multiple bylines (array = OR)", async () => {
		const a = await createPost("By Bob");
		const b = await createPost("By Alice");
		const c = await createPost("By Carol");
		await credit(a.id, "byline_bob", 0);
		await credit(b.id, "byline_alice", 0);
		await credit(c.id, "byline_carol", 0);

		const result = await load({ byline: ["byline_bob", "byline_alice"] });

		const titles = result.entries.map((e) => e.data.title);
		expect(titles).toHaveLength(2);
		expect(titles).toContain("By Bob");
		expect(titles).toContain("By Alice");
	});

	it("does not duplicate an entry credited to multiple requested bylines", async () => {
		const post = await createPost("Duo");
		await credit(post.id, "byline_alice", 0);
		await credit(post.id, "byline_bob", 1);

		const result = await load({ byline: ["byline_alice", "byline_bob"] });

		// SELECT DISTINCT collapses the two-row join fan-out.
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("Duo");
	});

	it("combines byline filter with a field filter (AND)", async () => {
		const a = await createPost("Bob Alpha", { series: "alpha" });
		const b = await createPost("Bob Beta", { series: "beta" });
		await credit(a.id, "byline_bob", 0);
		await credit(b.id, "byline_bob", 0);

		const result = await load({ byline: "byline_bob", series: "alpha" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("Bob Alpha");
	});

	it("combines byline filter with a taxonomy filter (AND)", async () => {
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: "tax_cat_news",
				name: "category",
				slug: "news",
				label: "News",
			} as never)
			.execute();

		const a = await createPost("Bob News");
		const b = await createPost("Bob Other");
		await credit(a.id, "byline_bob", 0);
		await credit(b.id, "byline_bob", 0);
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection: "post", entry_id: a.id, taxonomy_id: "tax_cat_news" } as never)
			.execute();

		const result = await load({ byline: "byline_bob", category: "news" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("Bob News");
	});

	it("returns no entries when the byline filter is an empty array", async () => {
		const post = await createPost("Anything");
		await credit(post.id, "byline_alice", 0);

		const result = await load({ byline: [] });

		expect(result.entries).toHaveLength(0);
	});

	it("ignores range operators on the byline key", async () => {
		const credited = await createPost("Credited");
		await credit(credited.id, "byline_alice", 0);
		// A second published post with NO byline credit. If the byline filter
		// were (incorrectly) applied, this entry would be excluded; if the
		// range is correctly dropped, both entries return.
		await createPost("Uncredited");

		const result = await load({ byline: { gte: "a" } });

		const titles = result.entries.map((e) => e.data.title);
		expect(titles).toHaveLength(2);
		expect(titles).toContain("Credited");
		expect(titles).toContain("Uncredited");
	});

	it("returns no entries when a taxonomy filter is an empty array", async () => {
		await db
			.insertInto("taxonomies" as never)
			.values({ id: "tax_cat_news", name: "category", slug: "news", label: "News" } as never)
			.execute();
		const post = await createPost("Anything");
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection: "post", entry_id: post.id, taxonomy_id: "tax_cat_news" } as never)
			.execute();

		// An empty taxonomy array must short-circuit, not emit `t.slug IN ()`.
		const result = await load({ category: [] });

		expect(result.entries).toHaveLength(0);
	});
});
