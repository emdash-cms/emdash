import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleMenuCreate,
	handleMenuItemCreate,
	handleMenuItemReorder,
	handleMenuItemUpdate,
} from "../../../src/api/handlers/menus.js";
import type { Database } from "../../../src/database/types.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const itemInput = (label: string) => ({
	type: "custom" as const,
	label,
	customUrl: `/${label.toLowerCase()}`,
});

interface TestItem {
	id: string;
	parentId: string | null;
	sortOrder: number;
}

describeEachDialect("menu item parent validation", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let nextSortOrder: number;

	beforeEach(async () => {
		nextSortOrder = 0;
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		const menu = await handleMenuCreate(db, { name: "primary", label: "Primary" });
		expect(menu.success).toBe(true);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createItem(label: string, parentId?: string): Promise<TestItem> {
		const result = await handleMenuItemCreate(db, "primary", {
			...itemInput(label),
			parentId,
			sortOrder: nextSortOrder++,
		});
		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error.message);
		return {
			id: result.data.id,
			parentId: result.data.parentId,
			sortOrder: result.data.sortOrder,
		};
	}

	async function createMenuItem(menuName: string, label: string): Promise<TestItem> {
		const result = await handleMenuItemCreate(db, menuName, itemInput(label));
		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error.message);
		return { id: result.data.id, parentId: result.data.parentId, sortOrder: result.data.sortOrder };
	}

	function expectValidation(result: { success: boolean; error?: { code: string } }): void {
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error?.code).toBe("VALIDATION_ERROR");
	}

	async function reorder(items: Array<{ id: string; parentId: string | null; sortOrder: number }>) {
		return handleMenuItemReorder(db, "primary", items);
	}

	async function currentItems(): Promise<TestItem[]> {
		const menu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", "primary")
			.executeTakeFirstOrThrow();
		const rows = await db
			.selectFrom("_emdash_menu_items")
			.select(["id", "parent_id", "sort_order"])
			.where("menu_id", "=", menu.id)
			.orderBy("sort_order", "asc")
			.execute();
		return rows.map((item) => ({
			id: item.id,
			parentId: item.parent_id,
			sortOrder: item.sort_order,
		}));
	}

	it("rejects create parents that are missing or belong to another menu", async () => {
		await handleMenuCreate(db, { name: "footer", label: "Footer" });
		const foreign = await createMenuItem("footer", "Foreign");

		const missing = await handleMenuItemCreate(db, "primary", {
			...itemInput("Missing"),
			parentId: "01MISSINGPARENT000000000000",
		});
		const crossMenu = await handleMenuItemCreate(db, "primary", {
			...itemInput("Cross menu"),
			parentId: foreign.id,
		});
		expectValidation(missing);
		expectValidation(crossMenu);
		expect(await currentItems()).toEqual([]);
	});

	it("rejects update parents that are self, missing, cross-menu, or descendants", async () => {
		await handleMenuCreate(db, { name: "footer", label: "Footer" });
		const foreign = await createMenuItem("footer", "Foreign");
		const root = await createItem("Root");
		const child = await createItem("Child", root.id);
		const grandchild = await createItem("Grandchild", child.id);
		const greatGrandchild = await createItem("Great grandchild", grandchild.id);

		const before = await currentItems();
		for (const parentId of [root.id, "01MISSINGPARENT000000000000", foreign.id, grandchild.id]) {
			const result = await handleMenuItemUpdate(db, "primary", root.id, { parentId });
			expectValidation(result);
		}
		const descendant = await handleMenuItemUpdate(db, "primary", child.id, {
			parentId: greatGrandchild.id,
		});
		expectValidation(descendant);
		expect(await currentItems()).toEqual(before);
	});

	it("allows nested create, update, and null reparenting", async () => {
		const root = await createItem("Root");
		const child = await createItem("Child", root.id);
		const grandchild = await createItem("Grandchild", child.id);
		const updated = await handleMenuItemUpdate(db, "primary", grandchild.id, { parentId: null });
		expect(updated.success).toBe(true);
		if (updated.success) expect(updated.data.parentId).toBeNull();

		const nestedAgain = await handleMenuItemUpdate(db, "primary", grandchild.id, {
			parentId: root.id,
		});
		expect(nestedAgain.success).toBe(true);
		if (nestedAgain.success) expect(nestedAgain.data.parentId).toBe(root.id);
	});

	it("rejects self, two-item, and three-item reorder cycles", async () => {
		const a = await createItem("A");
		const b = await createItem("B");
		const c = await createItem("C");

		expectValidation(await reorder([{ id: a.id, parentId: a.id, sortOrder: 0 }]));
		expectValidation(
			await reorder([
				{ id: a.id, parentId: b.id, sortOrder: 0 },
				{ id: b.id, parentId: a.id, sortOrder: 1 },
			]),
		);
		expectValidation(
			await reorder([
				{ id: a.id, parentId: b.id, sortOrder: 0 },
				{ id: b.id, parentId: c.id, sortOrder: 1 },
				{ id: c.id, parentId: a.id, sortOrder: 2 },
			]),
		);
	});

	it("rejects reorder parents that are missing or belong to another menu", async () => {
		await handleMenuCreate(db, { name: "footer", label: "Footer" });
		const foreign = await createMenuItem("footer", "Foreign");
		const item = await createItem("Item");

		expectValidation(
			await reorder([{ id: item.id, parentId: "01MISSINGPARENT000000000000", sortOrder: 4 }]),
		);
		expectValidation(await reorder([{ id: item.id, parentId: foreign.id, sortOrder: 4 }]));
	});

	it("rejects a two-item cycle atomically and still renders both roots", async () => {
		const a = await createItem("A");
		const b = await createItem("B");
		const before = await currentItems();
		const result = await reorder([
			{ id: a.id, parentId: b.id, sortOrder: 7 },
			{ id: b.id, parentId: a.id, sortOrder: 8 },
		]);
		expectValidation(result);
		expect(await currentItems()).toEqual(before);
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items.map((item) => item.id)).toEqual([a.id, b.id]);
	});

	it("accepts a final valid state when the batch reverses an edge, in either order", async () => {
		for (const batch of ["clear-first", "create-first"] as const) {
			const a = await createItem(`A-${batch}`);
			const b = await createItem(`B-${batch}`, a.id);
			const updates = [
				{ id: b.id, parentId: null, sortOrder: 1 },
				{ id: a.id, parentId: b.id, sortOrder: 0 },
			];
			const result = await reorder(batch === "clear-first" ? updates : updates.toReversed());
			expect(result.success).toBe(true);
			const after = await currentItems();
			expect(after.find((item) => item.id === b.id)?.parentId).toBeNull();
			expect(after.find((item) => item.id === a.id)?.parentId).toBe(b.id);
		}
	});

	it("rejects attaching to a pre-existing cycle and allows repairing it", async () => {
		const a = await createItem("A");
		const b = await createItem("B", a.id);
		await db
			.updateTable("_emdash_menu_items")
			.set({ parent_id: b.id })
			.where("id", "=", a.id)
			.execute();

		expectValidation(
			await handleMenuItemCreate(db, "primary", { ...itemInput("Child"), parentId: a.id }),
		);
		const detached = await handleMenuItemUpdate(db, "primary", a.id, { parentId: null });
		expect(detached.success).toBe(true);
		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items[0]?.id).toBe(a.id);
		expect(menu?.items[0]?.children[0]?.id).toBe(b.id);
	});

	// PostgreSQL retains the parent FK cascade, so deletion cannot leave this legacy state.
	it.skipIf(dialect === "postgres")(
		"allows full admin reorder batches with unchanged deleted-parent links",
		async () => {
			const a = await createItem("A");
			const b = await createItem("B", a.id);
			const c = await createItem("C", b.id);
			await db.deleteFrom("_emdash_menu_items").where("id", "=", a.id).execute();
			const result = await reorder([
				{ ...b, sortOrder: 3 },
				{ ...c, sortOrder: 2 },
			]);
			expect(result.success).toBe(true);
			const edited = await handleMenuItemUpdate(db, "primary", c.id, {
				label: "Edited",
				parentId: b.id,
			});
			expect(edited.success).toBe(true);
			const menu = await getMenuWithDb("primary", db);
			expect(menu?.items[0]?.id).toBe(b.id);
			expect(menu?.items[0]?.children[0]?.label).toBe("Edited");
		},
	);

	it("allows full admin reorder batches with untouched legacy cycles", async () => {
		const a = await createItem("A");
		const b = await createItem("B", a.id);
		const c = await createItem("C");
		await db
			.updateTable("_emdash_menu_items")
			.set({ parent_id: b.id })
			.where("id", "=", a.id)
			.execute();
		const result = await reorder([
			{ ...a, parentId: b.id, sortOrder: 3 },
			{ ...b, sortOrder: 2 },
			{ ...c, sortOrder: 1 },
		]);
		expect(result.success).toBe(true);
		expect((await currentItems()).find((item) => item.id === c.id)?.sortOrder).toBe(1);
	});

	it("rejects a partial batch that cycles through untouched items", async () => {
		const a = await createItem("A");
		const b = await createItem("B", a.id);
		const c = await createItem("C", b.id);
		const before = await currentItems();
		expectValidation(await reorder([{ id: a.id, parentId: c.id, sortOrder: 5 }]));
		expect(await currentItems()).toEqual(before);
	});
});
