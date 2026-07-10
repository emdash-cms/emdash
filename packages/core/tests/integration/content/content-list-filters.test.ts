import { beforeEach, afterEach, expect, it } from "vitest";

import {
	handleContentAuthors,
	handleContentCreate,
	handleContentList,
} from "../../../src/api/handlers/content.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// #1288: bring richer filtering into the admin content list — filter by
// author, by date range (timeframe), and by publish status. Status filtering
// already existed; these tests cover the new author + date-range support and
// the supporting authors endpoint.
describeEachDialect("content list filters (#1288)", (dialect) => {
	let ctx: DialectTestContext;
	let aliceId: string;
	let bobId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const users = new UserRepository(ctx.db);
		const alice = await users.create({ email: "alice@example.com", name: "Alice" });
		const bob = await users.create({ email: "bob@example.com", name: "Bob" });
		aliceId = alice.id;
		bobId = bob.id;

		// Three posts across 2023/2024/2025, two by Alice and one by Bob.
		const seed = [
			{ slug: "y2023", title: "Old", authorId: aliceId, createdAt: "2023-06-01T12:00:00.000Z" },
			{ slug: "y2024", title: "Mid", authorId: bobId, createdAt: "2024-06-01T12:00:00.000Z" },
			{ slug: "y2025", title: "New", authorId: aliceId, createdAt: "2025-06-01T12:00:00.000Z" },
		];
		for (const s of seed) {
			const created = await handleContentCreate(ctx.db, "posts", {
				slug: s.slug,
				data: { title: s.title },
				authorId: s.authorId,
				createdAt: s.createdAt,
			});
			if (!created.success) throw new Error(`seed ${s.slug} failed`);
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function slugsOf(result: {
		success: boolean;
		data?: { items: { slug: string | null }[] };
	}): string[] {
		if (!result.success || !result.data) throw new Error("list failed");
		return result.data.items.map((i) => i.slug ?? "");
	}

	it("filters by author", async () => {
		const result = await handleContentList(ctx.db, "posts", { authorId: aliceId });
		const slugs = slugsOf(result).toSorted();
		expect(slugs).toEqual(["y2023", "y2025"]);
		if (!result.success) throw new Error("list failed");
		// total must reflect the filter, not the full collection.
		expect(result.data.total).toBe(2);
	});

	it("filters by an inclusive createdAt date range", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			dateField: "createdAt",
			dateFrom: "2024-01-01T00:00:00.000Z",
			dateTo: "2024-12-31T23:59:59.999Z",
		});
		expect(slugsOf(result)).toEqual(["y2024"]);
	});

	it("includes a boundary timestamp when the upper bound is end-of-day", async () => {
		// The 2025 post is at 12:00; an end-of-day upper bound must include it.
		const result = await handleContentList(ctx.db, "posts", {
			dateField: "createdAt",
			dateFrom: "2025-06-01T00:00:00.000Z",
			dateTo: "2025-06-01T23:59:59.999Z",
		});
		expect(slugsOf(result)).toEqual(["y2025"]);
	});

	it("treats a date-only upper bound as inclusive of the whole day", async () => {
		// Regression: a bare `YYYY-MM-DD` upper bound must be widened to the
		// end of the day server-side, otherwise the 2024 post at 12:00 would
		// be excluded (since `2024-06-01T12:00:00Z` sorts after `2024-06-01`).
		const result = await handleContentList(ctx.db, "posts", {
			dateField: "createdAt",
			dateFrom: "2024-06-01",
			dateTo: "2024-06-01",
		});
		expect(slugsOf(result)).toEqual(["y2024"]);
	});

	it("supports an open-ended (from-only) range", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			dateField: "createdAt",
			dateFrom: "2024-06-01T00:00:00.000Z",
		});
		expect(slugsOf(result).toSorted()).toEqual(["y2024", "y2025"]);
	});

	it("combines author and date range filters", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			authorId: aliceId,
			dateField: "createdAt",
			dateFrom: "2025-01-01T00:00:00.000Z",
		});
		expect(slugsOf(result)).toEqual(["y2025"]);
	});

	it("ignores a date range with no field", async () => {
		// Half-specified filter (from/to without a field) must not silently
		// drop every row — it should behave as if no date filter was set.
		const result = await handleContentList(ctx.db, "posts", {
			dateFrom: "2024-01-01T00:00:00.000Z",
		});
		expect(slugsOf(result)).toHaveLength(3);
	});

	it("a publishedAt range excludes never-published rows", async () => {
		// None of the seeded posts are published, so a publishedAt range
		// returns nothing (their published_at is NULL).
		const result = await handleContentList(ctx.db, "posts", {
			dateField: "publishedAt",
			dateFrom: "2000-01-01T00:00:00.000Z",
			dateTo: "2100-01-01T00:00:00.000Z",
		});
		expect(slugsOf(result)).toHaveLength(0);
	});

	it("lists distinct content authors sorted by name", async () => {
		const result = await handleContentAuthors(ctx.db, "posts");
		if (!result.success) throw new Error("authors failed");
		expect(result.data.items.map((a) => a.name)).toEqual(["Alice", "Bob"]);
		expect(result.data.items.map((a) => a.id).toSorted()).toEqual([aliceId, bobId].toSorted());
	});

	it("excludes authors with no live content", async () => {
		// Carol exists as a user but has authored nothing.
		const users = new UserRepository(ctx.db);
		await users.create({ email: "carol@example.com", name: "Carol" });

		const result = await handleContentAuthors(ctx.db, "posts");
		if (!result.success) throw new Error("authors failed");
		expect(result.data.items.map((a) => a.name)).not.toContain("Carol");
	});
});
