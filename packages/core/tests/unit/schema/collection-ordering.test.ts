/**
 * Tests for collection ordering, grouping, and reordering features.
 *
 * Covers:
 * - sort_order and group fields on collections
 * - listCollections ordering by sort_order ASC, slug ASC
 * - listCollectionsWithFields ordering
 * - reorderCollections batch update
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

describe("Collection Ordering and Grouping", () => {
	let db: Kysely<EmDashDatabase>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		const sqlite = new Database(":memory:");
		db = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(db);
		registry = new SchemaRegistry(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("sort_order and group fields", () => {
		it("creates a collection with default sort_order=0 and null group", async () => {
			const collection = await registry.createCollection({
				slug: "posts",
				label: "Posts",
			});

			expect(collection.sortOrder).toBe(0);
			expect(collection.group ?? null).toBeNull();
		});

		it("creates a collection with explicit sortOrder and group", async () => {
			const collection = await registry.createCollection({
				slug: "blog",
				label: "Blog",
				sortOrder: 5,
				group: "Content",
			});

			expect(collection.sortOrder).toBe(5);
			expect(collection.group).toBe("Content");
		});

		it("updates sortOrder and group on an existing collection", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });

			const updated = await registry.updateCollection("posts", {
				sortOrder: 10,
				group: "Blog",
			});

			expect(updated.sortOrder).toBe(10);
			expect(updated.group).toBe("Blog");
		});
	});

	describe("listCollections ordering", () => {
		it("orders by sort_order ASC, then slug ASC", async () => {
			await registry.createCollection({ slug: "zebra", label: "Zebra", sortOrder: 1 });
			await registry.createCollection({ slug: "alpha", label: "Alpha", sortOrder: 1 });
			await registry.createCollection({ slug: "beta", label: "Beta", sortOrder: 0 });

			const collections = await registry.listCollections();
			const slugs = collections.map((c) => c.slug);

			// sortOrder=0 first, then sortOrder=1 sorted by slug
			expect(slugs).toEqual(["beta", "alpha", "zebra"]);
		});

		it("places default sortOrder=0 collections before higher values", async () => {
			await registry.createCollection({ slug: "high", label: "High", sortOrder: 100 });
			await registry.createCollection({ slug: "default", label: "Default" });

			const collections = await registry.listCollections();
			expect(collections[0].slug).toBe("default");
			expect(collections[1].slug).toBe("high");
		});
	});

	describe("listCollectionsWithFields ordering", () => {
		it("orders by sort_order ASC, then slug ASC", async () => {
			// Use inputs where alphabetical and sort_order disagree
			await registry.createCollection({ slug: "zebra", label: "Zebra", sortOrder: 0 });
			await registry.createCollection({ slug: "art", label: "Art", sortOrder: 1 });
			await registry.createCollection({ slug: "blog", label: "Blog", sortOrder: 0 });

			const collections = await registry.listCollectionsWithFields();
			const slugs = collections.map((c) => c.slug);

			// sort_order=0 first (blog, zebra by slug), then sort_order=1 (art)
			expect(slugs).toEqual(["blog", "zebra", "art"]);
		});

		it("includes group field in results", async () => {
			await registry.createCollection({
				slug: "products",
				label: "Products",
				group: "Shop",
				sortOrder: 1,
			});

			const collections = await registry.listCollectionsWithFields();
			const products = collections.find((c) => c.slug === "products");

			expect(products).toBeDefined();
			expect(products!.group).toBe("Shop");
			expect(products!.sortOrder).toBe(1);
		});
	});

	describe("reorderCollections", () => {
		it("updates sort_order for multiple collections", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts", sortOrder: 0 });
			await registry.createCollection({ slug: "pages", label: "Pages", sortOrder: 0 });
			await registry.createCollection({ slug: "blog", label: "Blog", sortOrder: 0 });

			await registry.reorderCollections([
				{ slug: "blog", sortOrder: 0 },
				{ slug: "posts", sortOrder: 1 },
				{ slug: "pages", sortOrder: 2 },
			]);

			const collections = await registry.listCollections();
			expect(collections.map((c) => c.slug)).toEqual(["blog", "posts", "pages"]);
		});

		it("preserves slug ordering for equal sort_order values", async () => {
			await registry.createCollection({ slug: "zebra", label: "Zebra" });
			await registry.createCollection({ slug: "alpha", label: "Alpha" });

			await registry.reorderCollections([
				{ slug: "alpha", sortOrder: 0 },
				{ slug: "zebra", sortOrder: 0 },
			]);

			const collections = await registry.listCollections();
			expect(collections.map((c) => c.slug)).toEqual(["alpha", "zebra"]);
		});

		it("handles partial reorder (only specified collections updated)", async () => {
			await registry.createCollection({ slug: "a", label: "A", sortOrder: 0 });
			await registry.createCollection({ slug: "b", label: "B", sortOrder: 0 });
			await registry.createCollection({ slug: "c", label: "C", sortOrder: 0 });

			await registry.reorderCollections([
				{ slug: "c", sortOrder: 0 },
				{ slug: "a", sortOrder: 1 },
			]);

			const collections = await registry.listCollections();
			// c=0, a=1, b=0 (unchanged) -> b and c both 0, sorted by slug
			expect(collections.map((c) => c.slug)).toEqual(["b", "c", "a"]);
		});

		it("throws SchemaError for non-existent collection slug", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts" });

			await expect(
				registry.reorderCollections([{ slug: "nonexistent", sortOrder: 0 }]),
			).rejects.toThrow();
		});
	});
});
