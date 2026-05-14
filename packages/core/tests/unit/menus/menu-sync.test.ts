/**
 * Tests for menu sync helpers.
 *
 * Covers:
 * - syncCollectionToMenu: adds collection-type menu item
 * - removeCollectionFromMenu: removes collection-type menu items
 * - computeMenuSyncDiff: computes diff between sidebar and menu
 * - applyMenuSyncDiff: applies the diff
 * - syncSidebarToMenu: full sync in one step
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ulid } from "ulidx";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	computeMenuSyncDiff,
	applyMenuSyncDiff,
	syncSidebarToMenu,
} from "../../../src/api/handlers/menu-sync.js";
import {
	syncCollectionToMenu,
	removeCollectionFromMenu,
} from "../../../src/api/handlers/schema.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

describe("Menu Sync", () => {
	let db: Kysely<EmDashDatabase>;
	let registry: SchemaRegistry;
	let menuId: string;

	beforeEach(async () => {
		const sqlite = new Database(":memory:");
		db = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(db);
		registry = new SchemaRegistry(db);

		// Create a primary menu for testing
		menuId = ulid();
		await db
			.insertInto("_emdash_menus")
			.values({
				id: menuId,
				name: "primary",
				label: "Primary Navigation",
			})
			.execute();
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function getMenuItems() {
		return db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("menu_id", "=", menuId)
			.orderBy("sort_order", "asc")
			.execute();
	}

	describe("syncCollectionToMenu", () => {
		it("adds a collection-type menu item to the specified menu", async () => {
			await registry.createCollection({ slug: "posts", label: "Blog Posts" });

			await syncCollectionToMenu(db, "posts", "Blog Posts", "primary");

			const items = await getMenuItems();
			const postItem = items.find((i) => i.reference_collection === "posts");

			expect(postItem).toBeDefined();
			expect(postItem!.type).toBe("collection");
			expect(postItem!.label).toBe("Blog Posts");
		});

		it("does not duplicate menu items on repeated calls", async () => {
			await registry.createCollection({ slug: "posts", label: "Blog Posts" });

			await syncCollectionToMenu(db, "posts", "Blog Posts", "primary");
			await syncCollectionToMenu(db, "posts", "Blog Posts", "primary");

			const items = await getMenuItems();
			const postItems = items.filter((i) => i.reference_collection === "posts");

			expect(postItems).toHaveLength(1);
		});

		it("silently fails when menu does not exist", async () => {
			await registry.createCollection({ slug: "posts", label: "Blog Posts" });

			// Should not throw
			await syncCollectionToMenu(db, "posts", "Blog Posts", "nonexistent");

			const items = await getMenuItems();
			expect(items).toHaveLength(0);
		});

		it("appends item at the end of existing items", async () => {
			// Add an existing item
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: ulid(),
					menu_id: menuId,
					type: "custom",
					label: "Home",
					custom_url: "/",
					sort_order: 0,
				})
				.execute();

			await registry.createCollection({ slug: "posts", label: "Blog Posts" });
			await syncCollectionToMenu(db, "posts", "Blog Posts", "primary");

			const items = await getMenuItems();
			expect(items).toHaveLength(2);
			expect(items[1].reference_collection).toBe("posts");
		});
	});

	describe("removeCollectionFromMenu", () => {
		it("removes collection-type menu items referencing the collection", async () => {
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: ulid(),
					menu_id: menuId,
					type: "collection",
					reference_collection: "posts",
					label: "Blog",
					sort_order: 0,
				})
				.execute();

			await removeCollectionFromMenu(db, "posts");

			const items = await getMenuItems();
			expect(items).toHaveLength(0);
		});

		it("does not affect non-collection menu items", async () => {
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: ulid(),
					menu_id: menuId,
					type: "custom",
					label: "Home",
					custom_url: "/",
					sort_order: 0,
				})
				.execute();

			await removeCollectionFromMenu(db, "posts");

			const items = await getMenuItems();
			expect(items).toHaveLength(1);
			expect(items[0].type).toBe("custom");
		});
	});

	describe("computeMenuSyncDiff", () => {
		it("returns empty diff when sidebar and menu are in sync", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts", sortOrder: 0 });
			await registry.createCollection({ slug: "pages", label: "Pages", sortOrder: 1 });

			// Add matching menu items
			await db
				.insertInto("_emdash_menu_items")
				.values([
					{
						id: ulid(),
						menu_id: menuId,
						type: "collection",
						reference_collection: "posts",
						label: "Posts",
						sort_order: 0,
					},
					{
						id: ulid(),
						menu_id: menuId,
						type: "collection",
						reference_collection: "pages",
						label: "Pages",
						sort_order: 1,
					},
				])
				.execute();

			const result = await computeMenuSyncDiff(db, "primary");
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.toAdd).toHaveLength(0);
				expect(result.data.toRemove).toHaveLength(0);
			}
		});

		it("identifies collections to add when not in menu", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts", sortOrder: 0 });
			await registry.createCollection({ slug: "products", label: "Products", sortOrder: 1 });

			const result = await computeMenuSyncDiff(db, "primary");
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.toAdd).toHaveLength(2);
				expect(result.data.toAdd.map((i) => i.referenceCollection)).toContain("posts");
				expect(result.data.toAdd.map((i) => i.referenceCollection)).toContain("products");
			}
		});

		it("identifies menu items to remove when collection is deleted", async () => {
			const itemId = ulid();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					type: "collection",
					reference_collection: "old_posts",
					label: "Old Posts",
					sort_order: 0,
				})
				.execute();

			const result = await computeMenuSyncDiff(db, "primary");
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.toRemove).toContain(itemId);
			}
		});
	});

	describe("applyMenuSyncDiff", () => {
		it("adds new menu items from diff", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts", sortOrder: 0 });

			const result = await applyMenuSyncDiff(db, {
				toAdd: [
					{ menuName: "primary", label: "Posts", referenceCollection: "posts", sortOrder: 0 },
				],
				toRemove: [],
				toReorder: [],
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.added).toBe(1);
			}

			const items = await getMenuItems();
			expect(items).toHaveLength(1);
			expect(items[0].reference_collection).toBe("posts");
		});

		it("removes menu items from diff", async () => {
			const itemId = ulid();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					type: "collection",
					reference_collection: "old",
					label: "Old",
					sort_order: 0,
				})
				.execute();

			const result = await applyMenuSyncDiff(db, {
				toAdd: [],
				toRemove: [itemId],
				toReorder: [],
			});

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.removed).toBe(1);
			}

			const items = await getMenuItems();
			expect(items).toHaveLength(0);
		});
	});

	describe("syncSidebarToMenu", () => {
		it("performs full sync in one step", async () => {
			await registry.createCollection({ slug: "posts", label: "Posts", sortOrder: 0 });
			await registry.createCollection({ slug: "pages", label: "Pages", sortOrder: 1 });

			const result = await syncSidebarToMenu(db, "primary");

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.added).toBe(2);
			}

			const items = await getMenuItems();
			expect(items).toHaveLength(2);
		});
	});
});
