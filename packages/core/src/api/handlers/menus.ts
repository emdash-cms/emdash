/**
 * Menu CRUD handlers.
 *
 * Business logic for menu and menu-item endpoints. Routes are thin wrappers
 * that parse input, check auth, and call these.
 *
 * i18n: Menus are per-locale. `(name, locale)` is unique, so the same `name`
 * (e.g. "primary") can exist in several locales within one translation_group.
 * Menu items carry a `locale` + `translation_group` as well, and their
 * `reference_id` points at the referenced content's translation_group (not a
 * specific row id), so a single menu item target survives content translations.
 */

import type { Kysely, Selectable } from "kysely";
import { ulid } from "ulidx";

import { withTransaction } from "../../database/transaction.js";
import type { Database, MenuItemTable, MenuTable } from "../../database/types.js";
import { getI18nConfig } from "../../i18n/config.js";
import type { ApiResult } from "../types.js";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export type MenuRow = Selectable<MenuTable>;
export type MenuItemRow = Selectable<MenuItemTable>;

export interface MenuListItem extends MenuRow {
	itemCount: number;
}

export interface MenuWithItems extends MenuRow {
	items: MenuItemRow[];
}

export interface MenuTranslationsResponse {
	translationGroup: string | null;
	translations: Array<{
		id: string;
		name: string;
		locale: string;
		label: string;
		updatedAt: string;
	}>;
}

// ---------------------------------------------------------------------------
// Menu handlers
// ---------------------------------------------------------------------------

/**
 * List menus with item counts. Filter by `locale` when provided; otherwise
 * return every menu row (each locale counts as its own menu for admin listing
 * purposes).
 */
export async function handleMenuList(
	db: Kysely<Database>,
	options: { locale?: string } = {},
): Promise<ApiResult<MenuListItem[]>> {
	try {
		// Single query: LEFT JOIN + GROUP BY for the per-menu item count.
		// Avoids the N+1 of one count query per menu.
		let query = db
			.selectFrom("_emdash_menus as m")
			.leftJoin("_emdash_menu_items as i", "i.menu_id", "m.id")
			.select(({ fn }) => [
				"m.id",
				"m.name",
				"m.label",
				"m.created_at",
				"m.updated_at",
				"m.locale",
				"m.translation_group",
				fn.count<number>("i.id").as("itemCount"),
			])
			.groupBy([
				"m.id",
				"m.name",
				"m.label",
				"m.created_at",
				"m.updated_at",
				"m.locale",
				"m.translation_group",
			])
			.orderBy("m.name", "asc");
		if (options.locale !== undefined) query = query.where("m.locale", "=", options.locale);
		const rows = await query.execute();

		// SQLite returns count as `number`, but some dialects (Postgres)
		// return `string` from a count() aggregate. Normalize to number.
		const menusWithCounts: MenuListItem[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			label: row.label,
			created_at: row.created_at,
			updated_at: row.updated_at,
			locale: row.locale,
			translation_group: row.translation_group,
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
 * Create a new menu. When `translationOf` is supplied the new menu joins the
 * source menu's translation_group (and gets the source's items cloned).
 */
export async function handleMenuCreate(
	db: Kysely<Database>,
	input: { name: string; label: string; locale?: string; translationOf?: string },
): Promise<ApiResult<MenuRow>> {
	try {
		// Resolve translation group + source (if we're creating a translation).
		let translationGroup: string | null = null;
		let sourceMenu: MenuRow | null = null;
		if (input.translationOf) {
			const src = await db
				.selectFrom("_emdash_menus")
				.selectAll()
				.where("id", "=", input.translationOf)
				.executeTakeFirst();
			if (!src) {
				return {
					success: false,
					error: { code: "NOT_FOUND", message: "Source menu for translation not found" },
				};
			}
			sourceMenu = src;
			translationGroup = src.translation_group ?? src.id;
		}

		// Duplicate guard: same (name, locale). Falls back to the configured
		// defaultLocale to match the column DEFAULT set by migration 036.
		const effectiveLocale = input.locale ?? getI18nConfig()?.defaultLocale ?? "en";
		const existing = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", input.name)
			.where("locale", "=", effectiveLocale)
			.executeTakeFirst();
		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Menu "${input.name}" already exists${
						input.locale ? ` in locale "${input.locale}"` : ""
					}`,
				},
			};
		}

		const id = ulid();

		await withTransaction(db, async (trx) => {
			await trx
				.insertInto("_emdash_menus")
				.values({
					id,
					name: input.name,
					label: input.label,
					...(input.locale !== undefined ? { locale: input.locale } : {}),
					translation_group: translationGroup ?? id,
				})
				.execute();

			// Clone items from the source menu (same reference_ids — they are
			// translation_groups, which are locale-agnostic). Each clone
			// inherits the source item's translation_group so a nav entry
			// identifies as the same logical item across menu translations.
			if (sourceMenu) {
				const sourceItems = await trx
					.selectFrom("_emdash_menu_items")
					.selectAll()
					.where("menu_id", "=", sourceMenu.id)
					.orderBy("sort_order", "asc")
					.execute();
				if (sourceItems.length > 0) {
					// Build old-id → new-id map so parent pointers land on the clones.
					const idMap = new Map<string, string>();
					for (const item of sourceItems) idMap.set(item.id, ulid());

					await trx
						.insertInto("_emdash_menu_items")
						.values(
							sourceItems.map((item) => {
								const newId = idMap.get(item.id)!;
								return {
									id: newId,
									menu_id: id,
									parent_id: item.parent_id ? (idMap.get(item.parent_id) ?? null) : null,
									sort_order: item.sort_order,
									type: item.type,
									reference_collection: item.reference_collection,
									reference_id: item.reference_id,
									custom_url: item.custom_url,
									label: item.label,
									title_attr: item.title_attr,
									target: item.target,
									css_classes: item.css_classes,
									...(input.locale !== undefined ? { locale: input.locale } : {}),
									translation_group: item.translation_group ?? item.id,
								};
							}),
						)
						.execute();
				}
			}
		});

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
 * Get a single menu by name. Honours an optional `locale` filter; when two
 * menus share a name across locales, the locale distinguishes them.
 */
export async function handleMenuGet(
	db: Kysely<Database>,
	name: string,
	options: { locale?: string } = {},
): Promise<ApiResult<MenuWithItems>> {
	try {
		let query = db.selectFrom("_emdash_menus").selectAll().where("name", "=", name);
		if (options.locale !== undefined) query = query.where("locale", "=", options.locale);
		const menu = await query.orderBy("locale", "asc").executeTakeFirst();

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
 * Get a menu by id. Useful when the caller already has the id (e.g. after
 * creating a translation and navigating to it).
 */
export async function handleMenuGetById(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<MenuWithItems>> {
	try {
		const menu = await db
			.selectFrom("_emdash_menus")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Menu '${id}' not found` },
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
 * Update a menu's label. The name + locale are immutable.
 */
export async function handleMenuUpdate(
	db: Kysely<Database>,
	name: string,
	input: { label?: string; locale?: string },
): Promise<ApiResult<MenuRow>> {
	try {
		let query = db.selectFrom("_emdash_menus").select("id").where("name", "=", name);
		if (input.locale !== undefined) query = query.where("locale", "=", input.locale);
		const menu = await query.executeTakeFirst();

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
 * Delete a menu (and items, via cascade).
 */
export async function handleMenuDelete(
	db: Kysely<Database>,
	name: string,
	options: { locale?: string } = {},
): Promise<ApiResult<{ deleted: true }>> {
	try {
		let query = db.selectFrom("_emdash_menus").select("id").where("name", "=", name);
		if (options.locale !== undefined) query = query.where("locale", "=", options.locale);
		const menu = await query.executeTakeFirst();

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

/**
 * List every translation of a menu (by id or translation_group).
 */
export async function handleMenuTranslations(
	db: Kysely<Database>,
	idOrGroup: string,
): Promise<ApiResult<MenuTranslationsResponse>> {
	try {
		const anchor = await db
			.selectFrom("_emdash_menus")
			.selectAll()
			.where((eb) => eb.or([eb("id", "=", idOrGroup), eb("translation_group", "=", idOrGroup)]))
			.executeTakeFirst();
		if (!anchor) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu not found" },
			};
		}
		const group = anchor.translation_group ?? anchor.id;
		const rows = await db
			.selectFrom("_emdash_menus")
			.selectAll()
			.where("translation_group", "=", group)
			.orderBy("locale", "asc")
			.execute();
		return {
			success: true,
			data: {
				translationGroup: group,
				translations: rows.map((row) => ({
					id: row.id,
					name: row.name,
					locale: row.locale,
					label: row.label,
					updatedAt: row.updated_at,
				})),
			},
		};
	} catch {
		return {
			success: false,
			error: { code: "MENU_TRANSLATIONS_ERROR", message: "Failed to list menu translations" },
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
 * Add an item to a menu. The item inherits the menu's locale (so listing
 * items by locale stays trivial).
 */
export async function handleMenuItemCreate(
	db: Kysely<Database>,
	menuName: string,
	input: CreateMenuItemInput,
	options: { locale?: string } = {},
): Promise<ApiResult<MenuItemRow>> {
	try {
		let menuQuery = db
			.selectFrom("_emdash_menus")
			.select(["id", "locale"])
			.where("name", "=", menuName);
		if (options.locale !== undefined) menuQuery = menuQuery.where("locale", "=", options.locale);
		const menu = await menuQuery.executeTakeFirst();

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
				locale: menu.locale,
				translation_group: id,
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
	options: { locale?: string } = {},
): Promise<ApiResult<MenuItemRow>> {
	try {
		let menuQuery = db.selectFrom("_emdash_menus").select("id").where("name", "=", menuName);
		if (options.locale !== undefined) menuQuery = menuQuery.where("locale", "=", options.locale);
		const menu = await menuQuery.executeTakeFirst();

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
	options: { locale?: string } = {},
): Promise<ApiResult<{ deleted: true }>> {
	try {
		let menuQuery = db.selectFrom("_emdash_menus").select("id").where("name", "=", menuName);
		if (options.locale !== undefined) menuQuery = menuQuery.where("locale", "=", options.locale);
		const menu = await menuQuery.executeTakeFirst();

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
	options: { locale?: string } = {},
): Promise<ApiResult<MenuItemRow[]>> {
	try {
		let menuQuery = db.selectFrom("_emdash_menus").select("id").where("name", "=", menuName);
		if (options.locale !== undefined) menuQuery = menuQuery.where("locale", "=", options.locale);
		const menu = await menuQuery.executeTakeFirst();

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
