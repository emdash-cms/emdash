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
		const menus = await db
			.selectFrom("_emdash_menus")
			.select(["id", "name", "label", "created_at", "updated_at"])
			.orderBy("name", "asc")
			.execute();

		const menusWithCounts = await Promise.all(
			menus.map(async (menu) => {
				const { count } = await db
					.selectFrom("_emdash_menu_items")
					.select(({ fn }) => fn.countAll<number>().as("count"))
					.where("menu_id", "=", menu.id)
					.executeTakeFirstOrThrow();

				return {
					...menu,
					itemCount: count,
				};
			}),
		);

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
				error: { code: "NOT_FOUND", message: "Menu not found" },
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
				error: { code: "NOT_FOUND", message: "Menu not found" },
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
				error: { code: "NOT_FOUND", message: "Menu not found" },
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
