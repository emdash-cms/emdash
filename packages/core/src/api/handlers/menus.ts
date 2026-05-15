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

import type { Kysely } from "kysely";

import {
	MenuGoneError,
	MenuRepository,
	type CreateMenuItemInput as CreateMenuItemRepoInput,
	type Menu,
	type MenuItem,
	type MenuListItem,
	type MenuWithItems,
	type SetMenuItem,
	type UpdateMenuItemInput as UpdateMenuItemRepoInput,
} from "../../database/repositories/menu.js";
import type { Database } from "../../database/types.js";
import { getI18nConfig } from "../../i18n/config.js";
import type { ApiResult } from "../types.js";

// Re-export entity types so route files and tests can import them from the
// handler module without having to know about the repository layout.
export type {
	Menu,
	MenuItem,
	MenuListItem,
	MenuTranslation,
	MenuWithItems,
} from "../../database/repositories/menu.js";

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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Error returned when a menu lookup by `name` matches multiple locale
 * variants and the caller did not pass `locale` to disambiguate. Maps to
 * HTTP 400 via `mapErrorStatus`. The available locales are surfaced in the
 * message so MCP/REST callers can recover by re-issuing with `locale`.
 */
function ambiguousMenuLocaleError(
	name: string,
	locales: readonly string[],
): { success: false; error: { code: "AMBIGUOUS_LOCALE"; message: string } } {
	const sortedLocales = locales.toSorted();
	return {
		success: false,
		error: {
			code: "AMBIGUOUS_LOCALE",
			message: `Menu '${name}' exists in multiple locales (${sortedLocales.join(
				", ",
			)}); pass 'locale' to disambiguate.`,
		},
	};
}

type ResolveMenuResult =
	| { success: true; menu: Menu }
	| { success: false; error: { code: "NOT_FOUND" | "AMBIGUOUS_LOCALE"; message: string } };

/**
 * Resolve a menu by name + optional locale to a single Menu, surfacing the
 * canonical NOT_FOUND / AMBIGUOUS_LOCALE errors. Every item handler relies on
 * this to translate (name, locale) into an unambiguous menu row.
 */
async function resolveMenu(
	repo: MenuRepository,
	name: string,
	options: { locale?: string },
): Promise<ResolveMenuResult> {
	const matches = await repo.findByName(name, options);
	if (matches.length === 0) {
		return {
			success: false,
			error: {
				code: "NOT_FOUND",
				message: `Menu '${name}' not found${options.locale ? ` in locale '${options.locale}'` : ""}`,
			},
		};
	}
	if (matches.length > 1) {
		return {
			success: false,
			error: ambiguousMenuLocaleError(
				name,
				matches.map((m) => m.locale),
			).error,
		};
	}
	return { success: true, menu: matches[0] };
}

// ---------------------------------------------------------------------------
// Menu handlers
// ---------------------------------------------------------------------------

/**
 * List menus with item counts. Filter by `locale` when provided.
 */
export async function handleMenuList(
	db: Kysely<Database>,
	options: { locale?: string } = {},
): Promise<ApiResult<MenuListItem[]>> {
	try {
		const repo = new MenuRepository(db);
		const items = await repo.findMany(options);
		return { success: true, data: items };
	} catch {
		return {
			success: false,
			error: { code: "MENU_LIST_ERROR", message: "Failed to fetch menus" },
		};
	}
}

/**
 * Create a new menu. When `translationOf` is supplied the new menu joins the
 * source menu's translation_group (and gets the source's items cloned by the
 * repository).
 */
export async function handleMenuCreate(
	db: Kysely<Database>,
	input: { name: string; label: string; locale?: string; translationOf?: string },
): Promise<ApiResult<Menu>> {
	try {
		// Translating from a source menu only makes sense when the caller
		// names the target locale: otherwise we'd silently clone into the
		// configured default, which is almost never what's intended (and
		// will collide if the source is already the default-locale menu).
		// Enforced here so REST/SDK callers get the same guard as MCP.
		if (input.translationOf && !input.locale) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "`locale` is required when `translationOf` is provided",
				},
			};
		}

		const repo = new MenuRepository(db);

		// Existence check up front so the repo's "Source not found" throw
		// becomes a clean NOT_FOUND on the API.
		if (input.translationOf) {
			const source = await repo.findById(input.translationOf);
			if (!source) {
				return {
					success: false,
					error: { code: "NOT_FOUND", message: "Source menu for translation not found" },
				};
			}
		}

		// Duplicate guard: same (name, locale). Falls back to the configured
		// defaultLocale to match the column DEFAULT set by migration 036.
		const effectiveLocale = input.locale ?? getI18nConfig()?.defaultLocale ?? "en";
		if (await repo.existsByNameAndLocale(input.name, effectiveLocale)) {
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

		const menu = await repo.create(input);
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
 *
 * Historical behaviour: when `locale` is omitted, returns the lowest-locale
 * match (deterministic). Mirrors the pre-repo handler.
 */
export async function handleMenuGet(
	db: Kysely<Database>,
	name: string,
	options: { locale?: string } = {},
): Promise<ApiResult<MenuWithItems>> {
	try {
		const repo = new MenuRepository(db);
		const matches = await repo.findByName(name, options);
		if (matches.length === 0) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Menu '${name}' not found` },
			};
		}
		const menu = matches[0];
		const items = await repo.findItems(menu.id);
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
		const repo = new MenuRepository(db);
		const menu = await repo.findWithItems(id);
		if (!menu) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Menu '${id}' not found` },
			};
		}
		return { success: true, data: menu };
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
): Promise<ApiResult<Menu>> {
	try {
		const repo = new MenuRepository(db);
		const resolved = await resolveMenu(repo, name, { locale: input.locale });
		if (!resolved.success) return resolved;
		const updated = await repo.update(resolved.menu.id, { label: input.label });
		if (!updated) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Menu '${name}' not found` },
			};
		}
		return { success: true, data: updated };
	} catch {
		return {
			success: false,
			error: { code: "MENU_UPDATE_ERROR", message: "Failed to update menu" },
		};
	}
}

/**
 * Delete a menu (and its items, via the repository's explicit cleanup).
 */
export async function handleMenuDelete(
	db: Kysely<Database>,
	name: string,
	options: { locale?: string } = {},
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const repo = new MenuRepository(db);
		const resolved = await resolveMenu(repo, name, options);
		if (!resolved.success) return resolved;
		await repo.delete(resolved.menu.id);
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
		const repo = new MenuRepository(db);
		const result = await repo.listTranslations(idOrGroup);
		if (!result) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu not found" },
			};
		}
		return { success: true, data: result };
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

export type CreateMenuItemInput = CreateMenuItemRepoInput;
export type UpdateMenuItemInput = UpdateMenuItemRepoInput;
export type MenuSetItemsInput = SetMenuItem;

/**
 * Add an item to a menu. The item inherits the menu's locale.
 */
export async function handleMenuItemCreate(
	db: Kysely<Database>,
	menuName: string,
	input: CreateMenuItemInput,
	options: { locale?: string } = {},
): Promise<ApiResult<MenuItem>> {
	try {
		const repo = new MenuRepository(db);
		const resolved = await resolveMenu(repo, menuName, options);
		if (!resolved.success) return resolved;

		const item = await repo.createItem(resolved.menu.id, resolved.menu.locale, input);
		return { success: true, data: item };
	} catch {
		return {
			success: false,
			error: { code: "MENU_ITEM_CREATE_ERROR", message: "Failed to create menu item" },
		};
	}
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
): Promise<ApiResult<MenuItem>> {
	try {
		const repo = new MenuRepository(db);
		const resolved = await resolveMenu(repo, menuName, options);
		if (!resolved.success) return resolved;

		const updated = await repo.updateItem(resolved.menu.id, itemId, input);
		if (!updated) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Menu item not found" },
			};
		}
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
		const repo = new MenuRepository(db);
		const resolved = await resolveMenu(repo, menuName, options);
		if (!resolved.success) return resolved;

		const deleted = await repo.deleteItem(resolved.menu.id, itemId);
		if (!deleted) {
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
// Atomic-replace menu items (used by the MCP `menu_set_items` tool and admin)
// ---------------------------------------------------------------------------

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
	options: { locale?: string } = {},
): Promise<ApiResult<{ name: string; itemCount: number }>> {
	// Validate parentIndex references — must be strictly earlier so the array
	// can be inserted in order with parents resolved first. Negative indices
	// are caught by Zod's `.nonnegative()` at the MCP boundary, but we guard
	// explicitly so REST routes / direct handler use get the same error.
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
		const repo = new MenuRepository(db);
		const resolved = await resolveMenu(repo, menuName, options);
		if (!resolved.success) return resolved;

		const { itemCount } = await repo.setItems(resolved.menu.id, resolved.menu.locale, items);
		return { success: true, data: { name: menuName, itemCount } };
	} catch (error) {
		// `MenuGoneError` is thrown from inside the repository transaction
		// when the menu was deleted concurrently between `resolveMenu` and the
		// setItems write. Returning NOT_FOUND mirrors the original handler's
		// in-transaction `notFoundSentinel` branch and keeps the response
		// shape stable for REST/MCP callers.
		if (error instanceof MenuGoneError) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Menu '${menuName}' not found${
						options.locale ? ` in locale '${options.locale}'` : ""
					}`,
				},
			};
		}
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
): Promise<ApiResult<MenuItem[]>> {
	try {
		const repo = new MenuRepository(db);
		const resolved = await resolveMenu(repo, menuName, options);
		if (!resolved.success) return resolved;

		const updated = await repo.reorderItems(resolved.menu.id, items);
		return { success: true, data: updated };
	} catch {
		return {
			success: false,
			error: { code: "MENU_REORDER_ERROR", message: "Failed to reorder menu items" },
		};
	}
}
