/**
 * Menu CRUD handlers
 *
 * Business logic for menu and menu-item endpoints.
 * Routes are thin wrappers that parse input, check auth, and call these.
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { withTransaction } from "../../database/transaction.js";
import type { Database, MenuItemTable, MenuTable } from "../../database/types.js";
import type { ApiResult } from "../types.js";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

type MenuRow = Omit<MenuTable, "created_at" | "updated_at"> & {
	created_at: string;
	updated_at: string;
};

type MenuItemRow = Omit<MenuItemTable, "created_at"> & {
	created_at: string;
};

export interface MenuListItem extends MenuRow {
	itemCount: number;
}

export interface MenuWithItems extends MenuRow {
	items: MenuItemRow[];
}

// ---------------------------------------------------------------------------
// Menu handlers
// ---------------------------------------------------------------------------

/**
 * List all menus with item counts.
 */
export async function handleMenuList(db: Kysely<Database>): Promise<ApiResult<MenuListItem[]>> {
	try {
		// Single query: LEFT JOIN + GROUP BY for the per-menu item count.
		// Avoids the N+1 of one count query per menu.
		const rows = await db
			.selectFrom("_emdash_menus as m")
			.leftJoin("_emdash_menu_items as i", "i.menu_id", "m.id")
			.select(({ fn }) => [
				"m.id",
				"m.name",
				"m.label",
				"m.created_at",
				"m.updated_at",
				fn.count<number>("i.id").as("itemCount"),
			])
			.groupBy(["m.id", "m.name", "m.label", "m.created_at", "m.updated_at"])
			.orderBy("m.name", "asc")
			.execute();

		// SQLite returns count as `number`, but some dialects (Postgres)
		// return `string` from a count() aggregate. Normalize to number.
		const menusWithCounts: MenuListItem[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			label: row.label,
			created_at: row.created_at,
			updated_at: row.updated_at,
			itemCount: typeof row.itemCount === "string" ? Number(row.itemCount) : row.itemCount,
		}));

		return { success: true, data: menusWithCounts };
	} catch {
		return {
			success: false,
			error: { code: "MENU_LIST_ERROR", message: "Failed to fetch menus" },
		};
	}
}

/**
 * Create a new menu.
 */
export async function handleMenuCreate(
	db: Kysely<Database>,
	input: { name: string; label: string },
): Promise<ApiResult<MenuRow>> {
	try {
		const existing = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", input.name)
			.executeTakeFirst();

		if (existing) {
			return {
				success: false,
				error: { code: "CONFLICT", message: `Menu with name "${input.name}" already exists` },
			};
		}

		const id = ulid();
		await db
			.insertInto("_emdash_menus")
			.values({
				id,
				name: input.name,
				label: input.label,
			})
			.execute();

		const menu = await db
			.selectFrom("_emdash_menus")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();

		return { success: true, data: menu };
	} catch {
		return {
			success: false,
			error: { code: "MENU_CREATE_ERROR", message: "Failed to create menu" },
		};
	}
}

/**
 * Get a single menu with all its items.
 */
export async function handleMenuGet(
	db: Kysely<Database>,
	name: string,
): Promise<ApiResult<MenuWithItems>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.selectAll()
			.where("name", "=", name)
			.executeTakeFirst();

		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Menu '${name}' not found` },
			};
		}

		const items = await db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("menu_id", "=", menu.id)
			.orderBy("sort_order", "asc")
			.execute();

		return { success: true, data: { ...menu, items } };
	} catch {
		return {
			success: false,
			error: { code: "MENU_GET_ERROR", message: "Failed to fetch menu" },
		};
	}
}

/**
 * Update a menu's metadata.
 */
export async function handleMenuUpdate(
	db: Kysely<Database>,
	name: string,
	input: { label?: string },
): Promise<ApiResult<MenuRow>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", name)
			.executeTakeFirst();

		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Menu '${name}' not found` },
			};
		}

		if (input.label) {
			await db
				.updateTable("_emdash_menus")
				.set({ label: input.label })
				.where("id", "=", menu.id)
				.execute();
		}

		const updated = await db
			.selectFrom("_emdash_menus")
			.selectAll()
			.where("id", "=", menu.id)
			.executeTakeFirstOrThrow();

		return { success: true, data: updated };
	} catch {
		return {
			success: false,
			error: { code: "MENU_UPDATE_ERROR", message: "Failed to update menu" },
		};
	}
}

/**
 * Delete a menu and its items (cascade).
 */
export async function handleMenuDelete(
	db: Kysely<Database>,
	name: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", name)
			.executeTakeFirst();

		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Menu '${name}' not found` },
			};
		}

		// D1 has FOREIGN KEYS off by default, so the migration's `ON DELETE
		// CASCADE` won't fire there. Delete items explicitly first — this is
		// idempotent on SQLite/Postgres where the cascade also fires.
		await db.deleteFrom("_emdash_menu_items").where("menu_id", "=", menu.id).execute();
		await db.deleteFrom("_emdash_menus").where("id", "=", menu.id).execute();

		return { success: true, data: { deleted: true } };
	} catch {
		return {
			success: false,
			error: { code: "MENU_DELETE_ERROR", message: "Failed to delete menu" },
		};
	}
}

// ---------------------------------------------------------------------------
// Menu item handlers
// ---------------------------------------------------------------------------

export interface CreateMenuItemInput {
	type: string;
	label: string;
	referenceCollection?: string;
	referenceId?: string;
	customUrl?: string;
	target?: string;
	titleAttr?: string;
	cssClasses?: string;
	parentId?: string;
	sortOrder?: number;
}

/**
 * Add an item to a menu.
 */
export async function handleMenuItemCreate(
	db: Kysely<Database>,
	menuName: string,
	input: CreateMenuItemInput,
): Promise<ApiResult<MenuItemRow>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", menuName)
			.executeTakeFirst();

		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu not found" },
			};
		}

		let sortOrder = input.sortOrder ?? 0;
		if (input.sortOrder === undefined) {
			const maxOrder = await db
				.selectFrom("_emdash_menu_items")
				.select(({ fn }) => fn.max("sort_order").as("max"))
				.where("menu_id", "=", menu.id)
				.where("parent_id", "is", input.parentId ?? null)
				.executeTakeFirst();

			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Kysely fn.max returns unknown; always a number for sort_order column
			sortOrder = ((maxOrder?.max as number) ?? -1) + 1;
		}

		const id = ulid();
		await db
			.insertInto("_emdash_menu_items")
			.values({
				id,
				menu_id: menu.id,
				parent_id: input.parentId ?? null,
				sort_order: sortOrder,
				type: input.type,
				reference_collection: input.referenceCollection ?? null,
				reference_id: input.referenceId ?? null,
				custom_url: input.customUrl ?? null,
				label: input.label,
				title_attr: input.titleAttr ?? null,
				target: input.target ?? null,
				css_classes: input.cssClasses ?? null,
			})
			.execute();

		const item = await db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();

		return { success: true, data: item };
	} catch {
		return {
			success: false,
			error: { code: "MENU_ITEM_CREATE_ERROR", message: "Failed to create menu item" },
		};
	}
}

export interface UpdateMenuItemInput {
	label?: string;
	customUrl?: string;
	target?: string;
	titleAttr?: string;
	cssClasses?: string;
	parentId?: string | null;
	sortOrder?: number;
}

/**
 * Update a menu item.
 */
export async function handleMenuItemUpdate(
	db: Kysely<Database>,
	menuName: string,
	itemId: string,
	input: UpdateMenuItemInput,
): Promise<ApiResult<MenuItemRow>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", menuName)
			.executeTakeFirst();

		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu not found" },
			};
		}

		const item = await db
			.selectFrom("_emdash_menu_items")
			.select("id")
			.where("id", "=", itemId)
			.where("menu_id", "=", menu.id)
			.executeTakeFirst();

		if (!item) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu item not found" },
			};
		}

		const updates: Record<string, unknown> = {};
		if (input.label !== undefined) updates.label = input.label;
		if (input.customUrl !== undefined) updates.custom_url = input.customUrl;
		if (input.target !== undefined) updates.target = input.target;
		if (input.titleAttr !== undefined) updates.title_attr = input.titleAttr;
		if (input.cssClasses !== undefined) updates.css_classes = input.cssClasses;
		if (input.parentId !== undefined) updates.parent_id = input.parentId;
		if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder;

		if (Object.keys(updates).length > 0) {
			await db.updateTable("_emdash_menu_items").set(updates).where("id", "=", itemId).execute();
		}

		const updated = await db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("id", "=", itemId)
			.executeTakeFirstOrThrow();

		return { success: true, data: updated };
	} catch {
		return {
			success: false,
			error: { code: "MENU_ITEM_UPDATE_ERROR", message: "Failed to update menu item" },
		};
	}
}

/**
 * Delete a menu item.
 */
export async function handleMenuItemDelete(
	db: Kysely<Database>,
	menuName: string,
	itemId: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", menuName)
			.executeTakeFirst();

		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu not found" },
			};
		}

		const result = await db
			.deleteFrom("_emdash_menu_items")
			.where("id", "=", itemId)
			.where("menu_id", "=", menu.id)
			.execute();

		if (result[0]?.numDeletedRows === 0n) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu item not found" },
			};
		}

		return { success: true, data: { deleted: true } };
	} catch {
		return {
			success: false,
			error: { code: "MENU_ITEM_DELETE_ERROR", message: "Failed to delete menu item" },
		};
	}
}

export interface ReorderItem {
	id: string;
	parentId: string | null;
	sortOrder: number;
}

// ---------------------------------------------------------------------------
// Atomic-replace menu items (used by the MCP `menu_set_items` tool)
// ---------------------------------------------------------------------------

export interface MenuSetItemsInput {
	label: string;
	type: "custom" | "page" | "post" | "taxonomy" | "collection";
	customUrl?: string;
	referenceCollection?: string;
	referenceId?: string;
	titleAttr?: string;
	target?: string;
	cssClasses?: string;
	/**
	 * Index of the parent item in this same array. Must be strictly less
	 * than the current item's index so the insert order resolves parents
	 * before children. `undefined` makes the item top-level.
	 */
	parentIndex?: number;
}

/**
 * Replace the entire set of items for a menu in one atomic transaction.
 *
 * Existing items are deleted and the new list is inserted in the order
 * provided. `parentIndex` references resolve to actual parent IDs as the
 * insert proceeds.
 */
export async function handleMenuSetItems(
	db: Kysely<Database>,
	menuName: string,
	items: MenuSetItemsInput[],
): Promise<ApiResult<{ name: string; itemCount: number }>> {
	// Validate parentIndex references — must be strictly earlier so
	// the array can be inserted in order with parents resolved first.
	// Negative indices are out of range; only Zod's `.nonnegative()` at
	// the MCP boundary catches them today, so guard explicitly here for
	// any caller that bypasses Zod (REST routes, direct handler use).
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item?.parentIndex !== undefined) {
			if (item.parentIndex < 0 || item.parentIndex >= i) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: `item[${i}].parentIndex (${item.parentIndex}) must reference an earlier item`,
					},
				};
			}
		}
	}

	try {
		// Sentinel for "menu not found" thrown from inside the transaction
		// so the rollback fires before we return the structured error.
		const notFoundSentinel = Symbol("menu-not-found");

		try {
			await withTransaction(db, async (trx) => {
				// Existence check INSIDE the transaction so a concurrent
				// menu_delete between lookup and write can't leave orphan
				// items on D1 (FKs disabled by default).
				const menu = await trx
					.selectFrom("_emdash_menus")
					.select("id")
					.where("name", "=", menuName)
					.executeTakeFirst();

				if (!menu) {
					throw notFoundSentinel;
				}

				await trx.deleteFrom("_emdash_menu_items").where("menu_id", "=", menu.id).execute();

				const insertedIds: string[] = [];
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					if (!item) continue;
					const id = ulid();
					const parentId =
						item.parentIndex !== undefined ? (insertedIds[item.parentIndex] ?? null) : null;
					await trx
						.insertInto("_emdash_menu_items")
						.values({
							id,
							menu_id: menu.id,
							parent_id: parentId,
							sort_order: i,
							type: item.type,
							reference_collection: item.referenceCollection ?? null,
							reference_id: item.referenceId ?? null,
							custom_url: item.customUrl ?? null,
							label: item.label,
							title_attr: item.titleAttr ?? null,
							target: item.target ?? null,
							css_classes: item.cssClasses ?? null,
						})
						.execute();
					insertedIds.push(id);
				}

				await trx
					.updateTable("_emdash_menus")
					.set({ updated_at: new Date().toISOString() })
					.where("id", "=", menu.id)
					.execute();
			});
		} catch (error) {
			if (error === notFoundSentinel) {
				return {
					success: false,
					error: { code: "NOT_FOUND", message: `Menu '${menuName}' not found` },
				};
			}
			throw error;
		}

		return { success: true, data: { name: menuName, itemCount: items.length } };
	} catch (error) {
		console.error("[emdash] handleMenuSetItems failed:", error);
		return {
			success: false,
			error: { code: "MENU_SET_ITEMS_ERROR", message: "Failed to set menu items" },
		};
	}
}

/**
 * Batch reorder menu items.
 */
export async function handleMenuItemReorder(
	db: Kysely<Database>,
	menuName: string,
	items: ReorderItem[],
): Promise<ApiResult<MenuItemRow[]>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", menuName)
			.executeTakeFirst();

		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu not found" },
			};
		}

		const updatedItems = await withTransaction(db, async (trx) => {
			for (const item of items) {
				await trx
					.updateTable("_emdash_menu_items")
					.set({
						parent_id: item.parentId,
						sort_order: item.sortOrder,
					})
					.where("id", "=", item.id)
					.where("menu_id", "=", menu.id)
					.execute();
			}

			return trx
				.selectFrom("_emdash_menu_items")
				.selectAll()
				.where("menu_id", "=", menu.id)
				.orderBy("sort_order", "asc")
				.execute();
		});

		return { success: true, data: updatedItems };
	} catch {
		return {
			success: false,
			error: { code: "MENU_REORDER_ERROR", message: "Failed to reorder menu items" },
		};
	}
}
