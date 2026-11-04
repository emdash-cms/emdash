/**
 * Menu import functions
 *
 * Import navigation menus from WordPress WXR exports or plugin API.
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { WxrNavMenu, WxrNavMenuItem } from "../cli/wxr/parser.js";
import type { Database } from "../database/types.js";
import type { MenuItemType } from "../menus/types.js";
import { invalidateMenuObjectCache } from "../object-cache/index.js";

/**
 * Result of menu import operation
 */
export interface MenuImportResult {
	/** Number of menus created */
	menusCreated: number;
	/** Number of menu items created */
	itemsCreated: number;
	/** Mapping from WP menu slug to EmDash menu ID */
	menuIdMap: Map<string, string>;
	/** Errors encountered during import */
	errors: Array<{ menu: string; error: string }>;
}

/**
 * Plugin API menu format (matches /emdash/v1/menus response)
 */
export interface PluginMenu {
	id: number;
	name: string; // slug
	label: string;
	items: PluginMenuItem[];
}

export interface PluginMenuItem {
	id: number;
	parent_id: number | null;
	sort_order: number;
	type: "custom" | "post_type" | "taxonomy";
	object: string | null; // 'page', 'post', 'category'
	object_id: number | null;
	url: string;
	title: string;
	target: string | null;
	classes: string | null;
}

/**
 * Import navigation menus from WXR export
 *
 * @param menus - Parsed navigation menus from WXR
 * @param db - Database connection
 * @param contentIdMap - Map from WP post ID to EmDash content ID (for resolving references)
 * @returns Import result with counts and ID mapping
 */
export async function importMenusFromWxr(
	menus: WxrNavMenu[],
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
): Promise<MenuImportResult> {
	const result: MenuImportResult = {
		menusCreated: 0,
		itemsCreated: 0,
		menuIdMap: new Map(),
		errors: [],
	};

	for (const menu of menus) {
		try {
			// Check if menu already exists
			const existing = await db
				.selectFrom("_emdash_menus")
				.select("id")
				.where("name", "=", menu.name)
				.executeTakeFirst();

			if (existing) {
				result.menuIdMap.set(menu.name, existing.id);
				continue; // Skip existing menus
			}

			// Create the menu
			const menuId = ulid();
			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: menu.name,
					label: menu.label,
				})
				.execute();

			result.menusCreated++;
			result.menuIdMap.set(menu.name, menuId);

			// Import menu items
			const itemsCreated = await importWxrMenuItems(menu.items, menuId, db, contentIdMap);
			result.itemsCreated += itemsCreated;
		} catch (error) {
			result.errors.push({
				menu: menu.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (result.menusCreated > 0) invalidateMenuObjectCache();
	return result;
}

/**
 * Import navigation menus from Plugin API
 *
 * @param menus - Menus from plugin API
 * @param db - Database connection
 * @param contentIdMap - Map from WP post ID to EmDash content ID
 * @returns Import result with counts and ID mapping
 */
export async function importMenusFromPlugin(
	menus: PluginMenu[],
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
): Promise<MenuImportResult> {
	const result: MenuImportResult = {
		menusCreated: 0,
		itemsCreated: 0,
		menuIdMap: new Map(),
		errors: [],
	};

	for (const menu of menus) {
		try {
			// Check if menu already exists
			const existing = await db
				.selectFrom("_emdash_menus")
				.select("id")
				.where("name", "=", menu.name)
				.executeTakeFirst();

			if (existing) {
				result.menuIdMap.set(menu.name, existing.id);
				continue;
			}

			// Create the menu
			const menuId = ulid();
			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: menu.name,
					label: menu.label,
				})
				.execute();

			result.menusCreated++;
			result.menuIdMap.set(menu.name, menuId);

			// Import menu items
			const itemsCreated = await importPluginMenuItems(menu.items, menuId, db, contentIdMap);
			result.itemsCreated += itemsCreated;
		} catch (error) {
			result.errors.push({
				menu: menu.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (result.menusCreated > 0) invalidateMenuObjectCache();
	return result;
}

/**
 * Import menu items from WXR format
 */
async function importWxrMenuItems(
	items: WxrNavMenuItem[],
	menuId: string,
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
): Promise<number> {
	// Build a map of WP menu item IDs to EmDash IDs for parent resolution
	const itemIdMap = new Map<number, string>();
	let count = 0;

	// Sort items by sort order to maintain hierarchy
	const sortedItems = items.toSorted((a, b) => a.sortOrder - b.sortOrder);

	// First pass: create all items with temporary parent IDs
	for (const item of sortedItems) {
		const itemId = ulid();
		itemIdMap.set(item.id, itemId);

		const { type, collection, referenceId, customUrl } = mapWxrMenuItem(item, contentIdMap);

		await db
			.insertInto("_emdash_menu_items")
			.values({
				id: itemId,
				menu_id: menuId,
				parent_id: null, // Will be set in second pass
				sort_order: item.sortOrder,
				type,
				reference_collection: collection,
				reference_id: referenceId,
				custom_url: customUrl,
				label: item.title,
				title_attr: null,
				target: item.target || null,
				css_classes: item.classes || null,
			})
			.execute();

		count++;
	}

	// Second pass: update parent IDs
	for (const item of sortedItems) {
		if (item.parentId) {
			const itemId = itemIdMap.get(item.id);
			const parentId = itemIdMap.get(item.parentId);

			if (itemId && parentId) {
				await db
					.updateTable("_emdash_menu_items")
					.set({ parent_id: parentId })
					.where("id", "=", itemId)
					.execute();
			}
		}
	}

	return count;
}

/**
 * Import menu items from Plugin API format
 */
async function importPluginMenuItems(
	items: PluginMenuItem[],
	menuId: string,
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
): Promise<number> {
	const itemIdMap = new Map<number, string>();
	let count = 0;

	const sortedItems = items.toSorted((a, b) => a.sort_order - b.sort_order);

	for (const item of sortedItems) {
		const itemId = ulid();
		itemIdMap.set(item.id, itemId);

		const { type, collection, referenceId, customUrl } = mapPluginMenuItem(item, contentIdMap);

		await db
			.insertInto("_emdash_menu_items")
			.values({
				id: itemId,
				menu_id: menuId,
				parent_id: null,
				sort_order: item.sort_order,
				type,
				reference_collection: collection,
				reference_id: referenceId,
				custom_url: customUrl,
				label: item.title,
				title_attr: null,
				target: item.target || null,
				css_classes: item.classes || null,
			})
			.execute();

		count++;
	}

	// Second pass: update parent IDs
	for (const item of sortedItems) {
		if (item.parent_id) {
			const itemId = itemIdMap.get(item.id);
			const parentId = itemIdMap.get(item.parent_id);

			if (itemId && parentId) {
				await db
					.updateTable("_emdash_menu_items")
					.set({ parent_id: parentId })
					.where("id", "=", itemId)
					.execute();
			}
		}
	}

	return count;
}

/**
 * Map WXR menu item to EmDash format
 */
function mapWxrMenuItem(
	item: WxrNavMenuItem,
	contentIdMap: Map<number, string>,
): {
	type: MenuItemType;
	collection: string | null;
	referenceId: string | null;
	customUrl: string | null;
} {
	switch (item.type) {
		case "custom":
			return {
				type: "custom",
				collection: null,
				referenceId: null,
				customUrl: item.url || "#",
			};

		case "post_type": {
			// Map WordPress object type to collection
			const collection = mapObjectToCollection(item.objectType);
			const referenceId = item.objectId ? contentIdMap.get(item.objectId) || null : null;

			// If we can't resolve the reference, fall back to custom URL
			if (!referenceId && item.url) {
				return {
					type: "custom",
					collection: null,
					referenceId: null,
					customUrl: item.url,
				};
			}

			return {
				type: collection === "pages" ? "page" : "post",
				collection,
				referenceId,
				customUrl: null,
			};
		}

		case "taxonomy":
			// For taxonomies, we need taxonomy support in menus
			// Fall back to custom URL for now
			return {
				type: "custom",
				collection: null,
				referenceId: null,
				customUrl: item.url || "#",
			};

		default:
			return {
				type: "custom",
				collection: null,
				referenceId: null,
				customUrl: item.url || "#",
			};
	}
}

/**
 * Map Plugin menu item to EmDash format
 */
function mapPluginMenuItem(
	item: PluginMenuItem,
	contentIdMap: Map<number, string>,
): {
	type: MenuItemType;
	collection: string | null;
	referenceId: string | null;
	customUrl: string | null;
} {
	switch (item.type) {
		case "custom":
			return {
				type: "custom",
				collection: null,
				referenceId: null,
				customUrl: item.url || "#",
			};

		case "post_type": {
			const collection = mapObjectToCollection(item.object);
			const referenceId = item.object_id ? contentIdMap.get(item.object_id) || null : null;

			if (!referenceId && item.url) {
				return {
					type: "custom",
					collection: null,
					referenceId: null,
					customUrl: item.url,
				};
			}

			return {
				type: collection === "pages" ? "page" : "post",
				collection,
				referenceId,
				customUrl: null,
			};
		}

		case "taxonomy":
			return {
				type: "custom",
				collection: null,
				referenceId: null,
				customUrl: item.url || "#",
			};

		default:
			return {
				type: "custom",
				collection: null,
				referenceId: null,
				customUrl: item.url || "#",
			};
	}
}

/**
 * Map WordPress object type to EmDash collection name
 */
function mapObjectToCollection(objectType: string | undefined | null): string {
	if (!objectType) return "posts";

	const mapping: Record<string, string> = {
		post: "posts",
		page: "pages",
		product: "products",
		portfolio: "portfolio",
	};

	return mapping[objectType] || objectType;
}
