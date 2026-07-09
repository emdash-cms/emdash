import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("Loader field filters", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		// Add a 'series' field to the post collection for field filtering tests
		const registry = new SchemaRegistry(db);
		await registry.createField("post", {
			slug: "series",
			label: "Series",
			type: "string",
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function createPost(title: string, opts: { series?: string; publishedAt?: string } = {}) {
		const result = await handleContentCreate(db, "post", {
			data: { title, series: opts.series ?? null },
			status: "published",
			publishedAt: opts.publishedAt,
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	it("should filter by exact field match", async () => {
		await createPost("Post A", { series: "alpha" });
		await createPost("Post B", { series: "beta" });
		await createPost("Post C", { series: "alpha" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", where: { series: "alpha" } } }),
		);

		expect(result.entries).toHaveLength(2);
		const titles = result.entries.map((e) => e.data.title);
		expect(titles).toContain("Post A");
		expect(titles).toContain("Post C");
	});

	it("should filter by multi-value field match (IN)", async () => {
		await createPost("Post A", { series: "alpha" });
		await createPost("Post B", { series: "beta" });
		await createPost("Post C", { series: "gamma" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { series: ["alpha", "gamma"] } },
			}),
		);

		expect(result.entries).toHaveLength(2);
		const titles = result.entries.map((e) => e.data.title);
		expect(titles).toContain("Post A");
		expect(titles).toContain("Post C");
	});

	it("should filter by date range (gte + lt)", async () => {
		await createPost("Old Post", { publishedAt: "2023-06-15T00:00:00Z" });
		await createPost("Mid Post", { publishedAt: "2024-03-01T00:00:00Z" });
		await createPost("New Post", { publishedAt: "2025-01-10T00:00:00Z" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { published_at: { gte: "2024-01-01T00:00:00Z", lt: "2025-01-01T00:00:00Z" } },
				},
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("Mid Post");
	});

	it("should combine field filter with cursor pagination", async () => {
		for (let i = 1; i <= 5; i++) {
			await createPost(`Alpha ${i}`, { series: "alpha" });
		}
		await createPost("Beta 1", { series: "beta" });

		const loader = emdashLoader();
		const page1 = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { series: "alpha" }, limit: 3 },
			}),
		);

		expect(page1.entries).toHaveLength(3);
		expect(page1.nextCursor).toBeTruthy();

		const page2 = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { series: "alpha" }, limit: 3, cursor: page1.nextCursor },
			}),
		);

		expect(page2.entries).toHaveLength(2);
		expect(page2.nextCursor).toBeUndefined();
	});

	it("should return all entries when where has only invalid field names", async () => {
		await createPost("Post A", { series: "alpha" });
		await createPost("Post B", { series: "beta" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { "invalid-field!": "value" } },
			}),
		);

		// Invalid field names are skipped, so no filter is applied
		expect(result.entries).toHaveLength(2);
	});

	it("should handle empty WhereRange object (no conditions added)", async () => {
		await createPost("Post A");
		await createPost("Post B");

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { published_at: {} } },
			}),
		);

		expect(result.entries).toHaveLength(2);
	});

	it("should filter by gt (strict greater than)", async () => {
		await createPost("Early", { publishedAt: "2024-01-01T00:00:00Z" });
		await createPost("Exact", { publishedAt: "2024-06-01T00:00:00Z" });
		await createPost("Late", { publishedAt: "2024-12-01T00:00:00Z" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { published_at: { gt: "2024-06-01T00:00:00Z" } },
				},
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("Late");
	});

	it("should combine exact match and range filter on different fields", async () => {
		await createPost("A-Old", { series: "alpha", publishedAt: "2023-06-01T00:00:00Z" });
		await createPost("A-New", { series: "alpha", publishedAt: "2024-06-01T00:00:00Z" });
		await createPost("B-New", { series: "beta", publishedAt: "2024-06-01T00:00:00Z" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: {
						series: "alpha",
						published_at: { gte: "2024-01-01T00:00:00Z" },
					},
				},
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("A-New");
	});

	it("should filter by lte (less than or equal)", async () => {
		await createPost("Early", { publishedAt: "2024-01-01T00:00:00Z" });
		await createPost("Exact", { publishedAt: "2024-06-01T00:00:00Z" });
		await createPost("Late", { publishedAt: "2024-12-01T00:00:00Z" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { published_at: { lte: "2024-06-01T00:00:00Z" } },
				},
			}),
		);

		expect(result.entries).toHaveLength(2);
		const titles = result.entries.map((e) => e.data.title);
		expect(titles).toContain("Early");
		expect(titles).toContain("Exact");
	});

	it("should combine taxonomy filter with field filter", async () => {
		// Create a taxonomy term and assign it to posts
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: "tax_cat_news",
				name: "category",
				slug: "news",
				label: "News",
				// content_taxonomies.taxonomy_id stores the term's translation_group
				// (migration 036). Single-locale terms seed translation_group = id.
				translation_group: "tax_cat_news",
			} as never)
			.execute();

		const postA = await createPost("A-News-Alpha", { series: "alpha" });
		const postB = await createPost("B-News-Beta", { series: "beta" });
		await createPost("C-Other-Alpha", { series: "alpha" });

		// Assign taxonomy to posts A and B
		await db
			.insertInto("content_taxonomies" as never)
			.values([
				{ collection: "post", entry_id: postA.id, taxonomy_id: "tax_cat_news" },
				{ collection: "post", entry_id: postB.id, taxonomy_id: "tax_cat_news" },
			] as never)
			.execute();

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { category: "news", series: "alpha" },
				},
			}),
		);

		// Only post A matches both category=news AND series=alpha
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("A-News-Alpha");
	});

	it("should preserve backward compatibility with taxonomy-only filter", async () => {
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: "tax_cat_tech",
				name: "category",
				slug: "tech",
				label: "Tech",
				translation_group: "tax_cat_tech",
			} as never)
			.execute();

		const postA = await createPost("Tech Post");
		await createPost("Other Post");

		await db
			.insertInto("content_taxonomies" as never)
			.values({
				collection: "post",
				entry_id: postA.id,
				taxonomy_id: "tax_cat_tech",
			} as never)
			.execute();

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { category: "tech" } },
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("Tech Post");
	});

	it("should skip null/undefined values in where filter", async () => {
		await createPost("Post A", { series: "alpha" });
		await createPost("Post B", { series: "beta" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { series: null as unknown as string },
				},
			}),
		);

		// null values are skipped, so no filter is applied
		expect(result.entries).toHaveLength(2);
	});

	it("should warn and skip range operators on taxonomy keys", async () => {
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: "tax_cat_range",
				name: "category",
				slug: "test",
				label: "Test",
				translation_group: "tax_cat_range",
			} as never)
			.execute();

		await createPost("Post A");
		await createPost("Post B");

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { category: { gte: "a" } as unknown as string },
				},
			}),
		);

		// Range on taxonomy is ignored, returns all entries
		expect(result.entries).toHaveLength(2);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("range operators are not supported on taxonomy"),
		);
		warnSpy.mockRestore();
	});

	it("should handle range with only one bound (lt without gte)", async () => {
		await createPost("Early", { publishedAt: "2023-01-01T00:00:00Z" });
		await createPost("Mid", { publishedAt: "2024-06-01T00:00:00Z" });
		await createPost("Late", { publishedAt: "2025-12-01T00:00:00Z" });

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { published_at: { lt: "2024-01-01T00:00:00Z" } },
				},
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].data.title).toBe("Early");
	});

	it("should return empty results for non-existent column in where filter", async () => {
		await createPost("Post A", { series: "alpha" });

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { nonexistent_column: "value" },
				},
			}),
		);

		expect(result.entries).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no such column"));
		warnSpy.mockRestore();
	});
});
