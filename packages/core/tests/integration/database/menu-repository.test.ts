/**
 * MenuRepository — repository-level tests
 *
 * Mirrors the coverage style of the other repository test suites
 * (`redirect-handlers.test.ts`, `taxonomy.test.ts`, etc.). The repository is
 * the single layer responsible for snake_case ↔ camelCase mapping and for
 * cross-table operations (translation cloning, atomic set-items, delete with
 * explicit item cleanup for D1 safety).
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MenuGoneError, MenuRepository } from "../../../src/database/repositories/menu.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("MenuRepository", () => {
	let db: Kysely<Database>;
	let repo: MenuRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new MenuRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("row → entity mapping", () => {
		it("create() returns a camelCase Menu", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			expect(menu).toMatchObject({ name: "primary", label: "Primary", locale: "en" });
			expect(typeof menu.createdAt).toBe("string");
			expect(typeof menu.updatedAt).toBe("string");
			expect(menu.translationGroup).toBe(menu.id);
			// no leakage of snake_case keys
			expect(menu).not.toHaveProperty("created_at");
			expect(menu).not.toHaveProperty("updated_at");
			expect(menu).not.toHaveProperty("translation_group");
		});

		it("createItem() returns a camelCase MenuItem", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			const item = await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "Blog",
				customUrl: "/blog",
			});
			expect(item).toMatchObject({
				menuId: menu.id,
				type: "custom",
				label: "Blog",
				customUrl: "/blog",
				sortOrder: 0,
				parentId: null,
			});
			expect(item.translationGroup).toBe(item.id);
			expect(item).not.toHaveProperty("custom_url");
			expect(item).not.toHaveProperty("menu_id");
			expect(item).not.toHaveProperty("sort_order");
		});
	});

	describe("findMany() — list with item counts", () => {
		it("returns 0 when there are no items", async () => {
			await repo.create({ name: "primary", label: "Primary" });
			const rows = await repo.findMany();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.itemCount).toBe(0);
		});

		it("counts items correctly", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			await repo.createItem(menu.id, menu.locale, { type: "custom", label: "A", customUrl: "/a" });
			await repo.createItem(menu.id, menu.locale, { type: "custom", label: "B", customUrl: "/b" });
			const rows = await repo.findMany();
			expect(rows[0]!.itemCount).toBe(2);
		});

		it("filters by locale when supplied", async () => {
			await repo.create({ name: "primary", label: "Primary" });
			await repo.create({ name: "primary", label: "Principal", locale: "es" });
			const all = await repo.findMany();
			expect(all).toHaveLength(2);
			const en = await repo.findMany({ locale: "en" });
			expect(en).toHaveLength(1);
			expect(en[0]!.locale).toBe("en");
		});
	});

	describe("findByName()", () => {
		it("returns multiple rows when the same name has translations", async () => {
			const src = await repo.create({ name: "primary", label: "Primary" });
			await repo.create({
				name: "primary",
				label: "Principal",
				locale: "es",
				translationOf: src.id,
			});
			const both = await repo.findByName("primary");
			expect(both).toHaveLength(2);
			expect(both.map((m) => m.locale).toSorted()).toEqual(["en", "es"]);
		});

		it("scopes by locale when supplied", async () => {
			const src = await repo.create({ name: "primary", label: "Primary" });
			await repo.create({
				name: "primary",
				label: "Principal",
				locale: "es",
				translationOf: src.id,
			});
			const es = await repo.findByName("primary", { locale: "es" });
			expect(es).toHaveLength(1);
			expect(es[0]!.locale).toBe("es");
		});
	});

	describe("create() with translationOf", () => {
		it("clones items into the new locale and shares translation_group", async () => {
			const src = await repo.create({ name: "primary", label: "Primary" });
			await repo.createItem(src.id, src.locale, { type: "custom", label: "Home", customUrl: "/" });
			await repo.createItem(src.id, src.locale, {
				type: "custom",
				label: "About",
				customUrl: "/about",
			});

			const target = await repo.create({
				name: "primary",
				label: "Principal",
				locale: "es",
				translationOf: src.id,
			});

			expect(target.translationGroup).toBe(src.translationGroup);

			const items = await repo.findItems(target.id);
			expect(items).toHaveLength(2);
			expect(items.map((i) => i.label)).toEqual(["Home", "About"]);
			expect(items.every((i) => i.locale === "es")).toBe(true);
			// Each cloned item shares the source item's translation_group so the
			// nav entry is treated as "the same logical item" across translations.
			const srcItems = await repo.findItems(src.id);
			const srcGroupsByLabel = new Map(srcItems.map((i) => [i.label, i.translationGroup]));
			for (const cloned of items) {
				expect(cloned.translationGroup).toBe(srcGroupsByLabel.get(cloned.label));
			}
		});

		it("throws when the source menu doesn't exist", async () => {
			await expect(
				repo.create({
					name: "primary",
					label: "Principal",
					locale: "es",
					translationOf: "01XXNOTREALXXXXXXXXXXXXXXX",
				}),
			).rejects.toThrow(/source/i);
		});
	});

	describe("delete() removes items first (D1-safe)", () => {
		it("deletes a menu and all its items", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "Home",
				customUrl: "/",
			});
			expect(await repo.findItems(menu.id)).toHaveLength(1);

			const deleted = await repo.delete(menu.id);
			expect(deleted).toBe(true);

			// No menu left, no orphaned items in the table either.
			expect(await repo.findById(menu.id)).toBeNull();
			const orphans = await db
				.selectFrom("_emdash_menu_items")
				.selectAll()
				.where("menu_id", "=", menu.id)
				.execute();
			expect(orphans).toHaveLength(0);
		});

		it("returns false when the menu doesn't exist", async () => {
			const deleted = await repo.delete("01XXNOTREALXXXXXXXXXXXXXXX");
			expect(deleted).toBe(false);
		});
	});

	describe("createItem() default sortOrder", () => {
		it("appends with the next available sortOrder when omitted", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			const a = await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "A",
				customUrl: "/a",
			});
			const b = await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "B",
				customUrl: "/b",
			});
			expect(a.sortOrder).toBe(0);
			expect(b.sortOrder).toBe(1);
		});

		it("calculates sortOrder per parent scope", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			const parent = await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "Parent",
				customUrl: "/p",
			});
			const child1 = await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "C1",
				customUrl: "/p/1",
				parentId: parent.id,
			});
			const child2 = await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "C2",
				customUrl: "/p/2",
				parentId: parent.id,
			});
			expect(child1.sortOrder).toBe(0);
			expect(child2.sortOrder).toBe(1);
		});
	});

	describe("updateItem()", () => {
		it("returns null when the item doesn't belong to the menu", async () => {
			const menu1 = await repo.create({ name: "primary", label: "Primary" });
			const menu2 = await repo.create({ name: "footer", label: "Footer" });
			const item = await repo.createItem(menu2.id, menu2.locale, {
				type: "custom",
				label: "A",
				customUrl: "/a",
			});
			// Try to update menu2's item via menu1.id — should fail.
			const result = await repo.updateItem(menu1.id, item.id, { customUrl: "/hijacked" });
			expect(result).toBeNull();
			// And the original value is untouched.
			const items = await repo.findItems(menu2.id);
			expect(items[0]!.customUrl).toBe("/a");
		});

		it("persists customUrl updates and keeps the camelCase shape", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			const item = await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "Blog",
				customUrl: "/blog",
			});
			const updated = await repo.updateItem(menu.id, item.id, { customUrl: "/new-blog" });
			expect(updated?.customUrl).toBe("/new-blog");
			expect(updated).not.toHaveProperty("custom_url");
		});
	});

	describe("deleteItem()", () => {
		it("scopes the delete by menu_id", async () => {
			const a = await repo.create({ name: "primary", label: "Primary" });
			const b = await repo.create({ name: "footer", label: "Footer" });
			const item = await repo.createItem(b.id, b.locale, {
				type: "custom",
				label: "X",
				customUrl: "/x",
			});

			// Attempting to delete it through the wrong menu should be a no-op.
			expect(await repo.deleteItem(a.id, item.id)).toBe(false);
			expect((await repo.findItems(b.id)).length).toBe(1);

			// Through the correct menu it deletes.
			expect(await repo.deleteItem(b.id, item.id)).toBe(true);
			expect((await repo.findItems(b.id)).length).toBe(0);
		});
	});

	describe("setItems()", () => {
		it("replaces existing items atomically and resolves parentIndex", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			await repo.createItem(menu.id, menu.locale, {
				type: "custom",
				label: "Old",
				customUrl: "/old",
			});

			const { itemCount } = await repo.setItems(menu.id, menu.locale, [
				{ label: "Root", type: "custom", customUrl: "/" },
				{ label: "Child", type: "custom", customUrl: "/child", parentIndex: 0 },
				{ label: "Grandchild", type: "custom", customUrl: "/gc", parentIndex: 1 },
			]);
			expect(itemCount).toBe(3);

			const items = await repo.findItems(menu.id);
			expect(items.map((i) => i.label)).toEqual(["Root", "Child", "Grandchild"]);
			const byLabel = new Map(items.map((i) => [i.label, i]));
			expect(byLabel.get("Root")!.parentId).toBeNull();
			expect(byLabel.get("Child")!.parentId).toBe(byLabel.get("Root")!.id);
			expect(byLabel.get("Grandchild")!.parentId).toBe(byLabel.get("Child")!.id);
		});

		it("throws MenuGoneError when the menu disappears mid-flight (concurrent delete)", async () => {
			// Simulates the race that the original handler's in-transaction
			// `notFoundSentinel` guarded against: another caller deletes the
			// menu between the handler's `resolveMenu` lookup and the
			// repository's destructive setItems write. Without the in-tx
			// existence check we'd happily insert orphan items on D1 (FKs off).
			const menu = await repo.create({ name: "primary", label: "Primary" });
			// Delete the menu's row (and any items) to mimic the racing call.
			await db.deleteFrom("_emdash_menu_items").where("menu_id", "=", menu.id).execute();
			await db.deleteFrom("_emdash_menus").where("id", "=", menu.id).execute();

			await expect(
				repo.setItems(menu.id, "en", [{ label: "Stray", type: "custom", customUrl: "/stray" }]),
			).rejects.toBeInstanceOf(MenuGoneError);

			// No orphan items left behind by the aborted transaction.
			const orphans = await db
				.selectFrom("_emdash_menu_items")
				.selectAll()
				.where("menu_id", "=", menu.id)
				.execute();
			expect(orphans).toHaveLength(0);
		});

		it("touches updated_at on the menu", async () => {
			const menu = await repo.create({ name: "primary", label: "Primary" });
			const before = (await repo.findById(menu.id))!.updatedAt;
			// Force a measurable gap so timestamp resolution doesn't flake.
			await new Promise((r) => setTimeout(r, 10));
			await repo.setItems(menu.id, menu.locale, [{ label: "X", type: "custom", customUrl: "/x" }]);
			const after = (await repo.findById(menu.id))!.updatedAt;
			expect(after >= before).toBe(true);
		});
	});

	describe("reorderItems()", () => {
		it("ignores updates that target items outside the menu", async () => {
			const a = await repo.create({ name: "primary", label: "Primary" });
			const b = await repo.create({ name: "footer", label: "Footer" });
			const aItem = await repo.createItem(a.id, a.locale, {
				type: "custom",
				label: "A",
				customUrl: "/a",
			});
			const bItem = await repo.createItem(b.id, b.locale, {
				type: "custom",
				label: "B",
				customUrl: "/b",
			});

			// Pass the foreign item id through menu A's reorder — it should be
			// silently ignored (the where("menu_id", "=", a.id) guard rejects it).
			await repo.reorderItems(a.id, [
				{ id: aItem.id, parentId: null, sortOrder: 5 },
				{ id: bItem.id, parentId: null, sortOrder: 99 },
			]);

			const aItems = await repo.findItems(a.id);
			const bItems = await repo.findItems(b.id);
			expect(aItems[0]!.sortOrder).toBe(5);
			expect(bItems[0]!.sortOrder).toBe(0); // unchanged
		});
	});

	describe("listTranslations()", () => {
		it("returns every translation in the group", async () => {
			const src = await repo.create({ name: "primary", label: "Primary" });
			await repo.create({
				name: "primary",
				label: "Principal",
				locale: "es",
				translationOf: src.id,
			});

			const byId = await repo.listTranslations(src.id);
			expect(byId).not.toBeNull();
			expect(byId!.translationGroup).toBe(src.translationGroup);
			expect(byId!.translations).toHaveLength(2);
			expect(byId!.translations.map((t) => t.locale).toSorted()).toEqual(["en", "es"]);

			const byGroup = await repo.listTranslations(src.translationGroup!);
			expect(byGroup!.translations).toHaveLength(2);
		});

		it("returns null when neither id nor group matches", async () => {
			const result = await repo.listTranslations("01XXNOTREALXXXXXXXXXXXXXXX");
			expect(result).toBeNull();
		});
	});
});
