import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { MenuRepository } from "../../src/database/repositories/menu.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;
let repo: MenuRepository;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	repo = new MenuRepository(db);
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

async function createMenu(labels: string[]) {
	const menu = await repo.create({ name: "primary", label: "Primary", locale: "en" });
	const items = [];
	for (const label of labels) {
		items.push(await repo.createItem(menu.id, "en", { type: "custom", label, customUrl: "/" }));
	}
	return { menu, items };
}

async function itemRows() {
	return db
		.selectFrom("_emdash_menu_items")
		.select(["menu_id", "label", "parent_id", "sort_order"])
		.orderBy("label")
		.execute();
}

describe("menu writes on D1", () => {
	it("leaves every item in place when a reorder fails partway", async () => {
		const { menu, items } = await createMenu(["A", "B"]);
		const [a, b] = items;
		if (!a || !b) throw new Error("Expected two items");
		const before = await itemRows();
		await sql`
			CREATE TRIGGER fail_menu_item_reorder
			BEFORE UPDATE ON _emdash_menu_items
			WHEN NEW.sort_order = 99
			BEGIN SELECT RAISE(ABORT, 'menu item reorder rejected'); END
		`.execute(db);

		await expect(
			repo.reorderItems(menu.id, [
				{ id: a.id, parentId: null, sortOrder: 5 },
				{ id: b.id, parentId: null, sortOrder: 99 },
			]),
		).rejects.toThrow("menu item reorder rejected");
		expect(await itemRows()).toEqual(before);
	});

	it("keeps the existing items when replacing them fails", async () => {
		const { menu } = await createMenu(["A", "B"]);
		const before = await itemRows();
		await sql`
			CREATE TRIGGER fail_menu_item_replace
			BEFORE INSERT ON _emdash_menu_items
			WHEN NEW.label = 'Fail'
			BEGIN SELECT RAISE(ABORT, 'menu item replace rejected'); END
		`.execute(db);

		await expect(
			repo.setItems(menu.id, "en", [
				{ type: "custom", label: "C", customUrl: "/c" },
				{ type: "custom", label: "Fail", customUrl: "/fail" },
			]),
		).rejects.toThrow("menu item replace rejected");
		expect(await itemRows()).toEqual(before);
	});

	it("keeps a menu's items when deleting the menu fails", async () => {
		const { menu } = await createMenu(["A", "B"]);
		const before = await itemRows();
		await sql`
			CREATE TRIGGER fail_menu_delete
			BEFORE DELETE ON _emdash_menus
			BEGIN SELECT RAISE(ABORT, 'menu delete rejected'); END
		`.execute(db);

		await expect(repo.delete(menu.id)).rejects.toThrow("menu delete rejected");
		expect(await repo.findById(menu.id)).not.toBeNull();
		expect(await itemRows()).toEqual(before);
	});

	it("creates no translation when copying one of its items fails", async () => {
		const { menu } = await createMenu(["A", "Fail"]);
		await sql`
			CREATE TRIGGER fail_menu_item_copy
			BEFORE INSERT ON _emdash_menu_items
			WHEN NEW.label = 'Fail'
			BEGIN SELECT RAISE(ABORT, 'menu item copy rejected'); END
		`.execute(db);

		await expect(
			repo.create({ name: "primary", label: "Principal", locale: "fr", translationOf: menu.id }),
		).rejects.toThrow("menu item copy rejected");
		expect(await repo.findByName("primary")).toHaveLength(1);
		expect((await itemRows()).map((row) => row.menu_id)).toEqual([menu.id, menu.id]);
	});

	it("copies a menu with more items than one D1 statement can bind", async () => {
		const { menu, items } = await createMenu(Array.from({ length: 20 }, (_, i) => `Item ${i}`));
		const parent = items[0];
		if (!parent) throw new Error("Expected items");
		await repo.updateItem(menu.id, items[1]!.id, { parentId: parent.id });

		const translation = await repo.create({
			name: "primary",
			label: "Principal",
			locale: "fr",
			translationOf: menu.id,
		});

		const copies = await repo.findItems(translation.id);
		expect(copies).toHaveLength(20);
		expect(copies.every((item) => item.locale === "fr")).toBe(true);
		const copiedParent = copies.find((item) => item.label === "Item 0");
		const copiedChild = copies.find((item) => item.label === "Item 1");
		expect(copiedChild?.parentId).toBe(copiedParent?.id);
		expect(copiedChild?.translationGroup).toBe(items[1]!.translationGroup);
	});
});
