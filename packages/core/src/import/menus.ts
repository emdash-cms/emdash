/**
 * Menu import functions
 *
 * Import navigation menus from WordPress WXR exports or plugin API.
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { WxrNavMenu, WxrNavMenuItem } from "../cli/wxr/parser.js";
import { MenuRepository, type SetMenuItem } from "../database/repositories/menu.js";
import type { Database } from "../database/types.js";
import type { MenuItemType } from "../menus/types.js";
import { invalidateMenuObjectCache } from "../object-cache/index.js";
import { mapPostTypeToCollection } from "./utils.js";

/**
 * The address of the language switcher that Polylang adds to menus as a custom
 * link. Polylang replaces the item with the language links when it renders the
 * menu, so on its own the address leads nowhere.
 */
const POLYLANG_SWITCHER_URL = "#pll_switcher";

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
 * An imported entry that WXR menu items link to
 */
export interface WxrMenuTarget {
	/** Collection the entry was imported into */
	collection: string;
	/** The entry's translation group, which a menu item stores as its reference */
	translationGroup: string;
	/** Locale of the entry */
	locale: string;
	/** Title of the entry, which WordPress shows for an item without its own label */
	title: string;
}

/**
 * The collection that WXR menu items for a post type archive link to
 */
export interface WxrMenuArchive {
	/** Collection the post type was imported into */
	collection: string;
	/** Label of the collection, which an item without its own label shows */
	label: string;
}

/**
 * Result of a WXR menu import
 */
export interface WxrMenuImportResult extends MenuImportResult {
	/** Menus left as they were because the site has one with the same name in that locale */
	menusSkipped: number;
	/**
	 * Items left out because what they link to wasn't imported, or can't be told
	 * apart from another post with the same slug, and the export has no address for
	 * it, and Polylang language switchers, which only Polylang can turn into links
	 */
	itemsSkipped: number;
}

/**
 * Import navigation menus from WXR export
 *
 * Items link to the imported entries by translation group, as menus made in the
 * admin do. A menu takes the locale of the entries it links to when they share
 * one, since Polylang and WPML keep a menu per language; otherwise it takes
 * `defaultLocale`. A menu that already exists under its name in that locale is
 * left as it is.
 *
 * @param menus - Parsed navigation menus from WXR
 * @param db - Database connection
 * @param targets - Imported entries by WordPress post ID
 * @param defaultLocale - Locale for a menu whose entries don't share one
 * @param archives - Collections that post type archive items link to, by WordPress post type
 * @returns Import result with counts and ID mapping
 */
export async function importMenusFromWxr(
	menus: WxrNavMenu[],
	db: Kysely<Database>,
	targets: Map<number, WxrMenuTarget>,
	defaultLocale: string,
	archives: Map<string, WxrMenuArchive> = new Map(),
): Promise<WxrMenuImportResult> {
	const result: WxrMenuImportResult = {
		menusCreated: 0,
		itemsCreated: 0,
		menuIdMap: new Map(),
		errors: [],
		menusSkipped: 0,
		itemsSkipped: 0,
	};
	const repo = new MenuRepository(db);

	for (const menu of menus) {
		try {
			const { items, locales, skipped } = wxrMenuItems(menu.items, targets, archives);
			const [onlyLocale] = locales;
			const locale = locales.size === 1 && onlyLocale ? onlyLocale : defaultLocale;
			if (await repo.existsByNameAndLocale(menu.name, locale)) {
				result.menusSkipped++;
				continue;
			}

			const created = await repo.create({ name: menu.name, label: menu.label, locale });
			try {
				await repo.setItems(created.id, created.locale, items);
			} catch (error) {
				// An empty menu left behind would make a retried import skip this one
				await repo.delete(created.id);
				throw error;
			}

			result.menusCreated++;
			result.itemsCreated += items.length;
			result.itemsSkipped += skipped;
			result.menuIdMap.set(menu.name, created.id);
		} catch (error) {
			result.errors.push({
				menu: menu.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return result;
}

/**
 * Import navigation menus from Plugin API
 *
 * @param menus - Menus from plugin API
 * @param db - Database connection
 * @param contentIdMap - Map from WP post ID to EmDash content ID
 * @param collectionMap - Map from WP post ID to the EmDash collection it was imported into
 * @returns Import result with counts and ID mapping
 */
export async function importMenusFromPlugin(
	menus: PluginMenu[],
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
	collectionMap: Map<number, string>,
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
			const itemsCreated = await importPluginMenuItems(
				menu.items,
				menuId,
				db,
				contentIdMap,
				collectionMap,
			);
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
 * Turn a WXR menu's items into `setItems` input, each item after its parent and
 * siblings in WordPress's order. An item whose link is lost is left out, and its
 * children take its place under its parent.
 */
function wxrMenuItems(
	items: WxrNavMenuItem[],
	targets: Map<number, WxrMenuTarget>,
	archives: Map<string, WxrMenuArchive>,
): { items: SetMenuItem[]; locales: Set<string>; skipped: number } {
	const sorted = items.toSorted((a, b) => a.sortOrder - b.sortOrder);
	const indexById = new Map<number, number>();
	for (const [index, item] of sorted.entries()) {
		if (!indexById.has(item.id)) indexById.set(item.id, index);
	}
	const children = new Map<number, number[]>();
	const roots: number[] = [];
	for (const [index, item] of sorted.entries()) {
		const parent = item.parentId === undefined ? undefined : indexById.get(item.parentId);
		// An item whose parent isn't in this menu goes to the top level
		if (parent === undefined || parent === index) {
			roots.push(index);
			continue;
		}
		const siblings = children.get(parent) ?? [];
		siblings.push(index);
		children.set(parent, siblings);
	}

	const result: SetMenuItem[] = [];
	const locales = new Set<string>();
	const placed = new Set<number>();
	let skipped = 0;
	const place = (index: number, parentIndex: number | undefined): void => {
		const item = sorted[index];
		if (!item || placed.has(index)) return;
		placed.add(index);
		const mapped = mapWxrMenuItem(item, targets, archives);
		let childParent = parentIndex;
		if (mapped) {
			if (mapped.locale) locales.add(mapped.locale);
			childParent =
				result.push(parentIndex === undefined ? mapped.item : { ...mapped.item, parentIndex }) - 1;
		} else {
			skipped++;
		}
		for (const child of children.get(index) ?? []) place(child, childParent);
	};
	for (const index of roots) place(index, undefined);
	// Items whose parents form a cycle are never reached from the top level
	for (const index of sorted.keys()) place(index, undefined);

	return { items: result, locales, skipped };
}

/**
 * Import menu items from Plugin API format
 */
async function importPluginMenuItems(
	items: PluginMenuItem[],
	menuId: string,
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
	collectionMap: Map<number, string>,
): Promise<number> {
	const itemIdMap = new Map<number, string>();
	let count = 0;

	const sortedItems = items.toSorted((a, b) => a.sort_order - b.sort_order);

	for (const item of sortedItems) {
		const itemId = ulid();
		itemIdMap.set(item.id, itemId);

		const { type, collection, referenceId, customUrl } = mapPluginMenuItem(
			item,
			contentIdMap,
			collectionMap,
		);

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
 * Map a WXR menu item to `setItems` input. A post type archive links to the
 * archive of the collection its post type was imported into. Returns `null` when
 * the item's link is lost: what it links to wasn't imported, and the export has
 * no address for it. That includes taxonomy archives, which WordPress links to
 * without storing an address, and Polylang's language switcher, whose address is
 * a placeholder that only Polylang turns into language links.
 */
function mapWxrMenuItem(
	item: WxrNavMenuItem,
	targets: Map<number, WxrMenuTarget>,
	archives: Map<string, WxrMenuArchive>,
): { item: SetMenuItem; locale?: string } | null {
	const shared = { target: item.target || undefined, cssClasses: item.classes || undefined };
	const archive =
		item.type === "post_type_archive" && item.objectType
			? archives.get(item.objectType)
			: undefined;
	if (archive) {
		return {
			item: {
				...shared,
				// An archive link: the collection, with no entry
				type: "collection",
				referenceCollection: archive.collection,
				// WordPress shows the post type's archive label for an item without its own label
				label: item.title || archive.label,
			},
		};
	}
	const entry = item.type === "post_type" && item.objectId ? targets.get(item.objectId) : undefined;
	if (entry) {
		return {
			item: {
				...shared,
				// The types the admin's menu editor gives entries of these collections
				type:
					entry.collection === "pages"
						? "page"
						: entry.collection === "posts"
							? "post"
							: "collection",
				referenceCollection: entry.collection,
				referenceId: entry.translationGroup,
				// WordPress shows the entry's title for an item without its own label
				label: item.title || entry.title,
			},
			locale: entry.locale,
		};
	}
	if (item.type === "custom" && item.url === POLYLANG_SWITCHER_URL) return null;
	if (item.type === "custom" || item.url) {
		return {
			item: {
				...shared,
				type: "custom",
				customUrl: item.url || "#",
				label: item.title || item.url || "",
			},
		};
	}
	return null;
}

/**
 * Map Plugin menu item to EmDash format
 */
function mapPluginMenuItem(
	item: PluginMenuItem,
	contentIdMap: Map<number, string>,
	collectionMap: Map<number, string>,
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
			const collection =
				(item.object_id ? collectionMap.get(item.object_id) : undefined) ??
				mapObjectToCollection(item.object);
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
	return mapPostTypeToCollection(objectType);
}
