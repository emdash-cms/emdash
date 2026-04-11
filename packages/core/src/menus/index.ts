/**
 * Navigation menu runtime functions
 *
 * These are called from templates to query menus and resolve URLs.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { sanitizeHref } from "../utils/url.js";
import type { Menu, MenuItem, MenuItemRow } from "./types.js";

/**
 * Get menu by name with resolved URLs
 *
 * @example
 * ```ts
 * import { getMenu } from "emdash";
 *
 * const menu = await getMenu("primary");
 * if (menu) {
 *   console.log(menu.items); // Array of MenuItem with resolved URLs
 * }
 * ```
 */
export async function getMenu(name: string): Promise<Menu | null> {
	const db = await getDb();
	return getMenuWithDb(name, db);
}

/**
 * Get menu by name with resolved URLs (with explicit db)
 *
 * @internal Use `getMenu()` in templates. This variant is for admin routes
 * that already have a database handle.
 */
export async function getMenuWithDb(name: string, db: Kysely<Database>): Promise<Menu | null> {
	// Get menu
	const menuRow = await db
		.selectFrom("_emdash_menus")
		.selectAll()
		.where("name", "=", name)
		.executeTakeFirst();

	if (!menuRow) {
		return null;
	}

	// Get all menu items
	const itemRows = await db
		.selectFrom("_emdash_menu_items")
		.selectAll()
		.$castTo<MenuItemRow>()
		.where("menu_id", "=", menuRow.id)
		.orderBy("sort_order", "asc")
		.execute();

	// Resolve URLs and build tree
	const items = await buildMenuTree(itemRows, db);

	return {
		id: menuRow.id,
		name: menuRow.name,
		label: menuRow.label,
		items,
	};
}

/**
 * Get all menus (without items - for admin list)
 *
 * @example
 * ```ts
 * import { getMenus } from "emdash";
 *
 * const menus = await getMenus();
 * console.log(menus); // [{ id, name, label }]
 * ```
 */
export async function getMenus(): Promise<Array<{ id: string; name: string; label: string }>> {
	const db = await getDb();
	return getMenusWithDb(db);
}

/**
 * Get all menus (with explicit db)
 *
 * @internal Use `getMenus()` in templates. This variant is for admin routes
 * that already have a database handle.
 */
export async function getMenusWithDb(
	db: Kysely<Database>,
): Promise<Array<{ id: string; name: string; label: string }>> {
	const rows = await db
		.selectFrom("_emdash_menus")
		.select(["id", "name", "label"])
		.orderBy("name", "asc")
		.execute();

	return rows;
}

/**
 * Build hierarchical menu tree from flat array of items
 */
async function buildMenuTree(items: MenuItemRow[], db: Kysely<Database>): Promise<MenuItem[]> {
	// Pre-load URL patterns for all collections referenced in this menu
	const collectionSlugs = new Set<string>();
	for (const item of items) {
		if (item.reference_collection) {
			collectionSlugs.add(item.reference_collection);
		}
		if (item.type === "page" || item.type === "post") {
			collectionSlugs.add(item.reference_collection || `${item.type}s`);
		}
	}

	const urlPatterns = new Map<string, string | null>();
	if (collectionSlugs.size > 0) {
		const rows = await db
			.selectFrom("_emdash_collections")
			.select(["slug", "url_pattern"])
			.where("slug", "in", [...collectionSlugs])
			.execute();
		for (const row of rows) {
			urlPatterns.set(row.slug, row.url_pattern);
		}
	}

	// Resolve all URLs first
	const resolvedItems = await Promise.all(
		items.map((item) => resolveMenuItem(item, db, urlPatterns)),
	);

	// Filter out items that couldn't be resolved (e.g., deleted content)
	const validItems = resolvedItems.filter((item) => item !== null);

	// Build tree structure
	const itemMap = new Map<string, MenuItem & { children: MenuItem[] }>();
	const rootItems: MenuItem[] = [];

	// First pass: create all items
	for (const item of validItems) {
		itemMap.set(item.id, { ...item, children: [] });
	}

	// Second pass: build parent-child relationships
	for (const item of items) {
		const menuItem = itemMap.get(item.id);
		if (!menuItem) continue;

		if (item.parent_id) {
			const parent = itemMap.get(item.parent_id);
			if (parent) {
				parent.children.push(menuItem);
			} else {
				// Parent not found, treat as root
				rootItems.push(menuItem);
			}
		} else {
			rootItems.push(menuItem);
		}
	}

	return rootItems;
}

/**
 * Resolve a single menu item's URL
 *
 * Returns null if the referenced content no longer exists (item should be skipped)
 */
async function resolveMenuItem(
	item: MenuItemRow,
	db: Kysely<Database>,
	urlPatterns: Map<string, string | null>,
): Promise<MenuItem | null> {
	let url: string | null;

	try {
		switch (item.type) {
			case "custom":
				url = item.custom_url || "#";
				break;

			case "page":
			case "post":
				url = await resolveContentUrl(
					// Default to plural collection name (pages/posts) if not specified
					item.reference_collection || `${item.type}s`,
					item.reference_id,
					db,
					urlPatterns,
				);
				// Skip items where content no longer exists
				if (url === null) {
					return null;
				}
				break;

			case "taxonomy":
				url = await resolveTaxonomyUrl(item.reference_id, db);
				// Skip items where taxonomy no longer exists
				if (url === null) {
					return null;
				}
				break;

			case "collection":
				url = `/${item.reference_collection}/`;
				break;

			default:
				if (item.reference_collection && item.reference_id) {
					url = await resolveContentUrl(
						item.reference_collection,
						item.reference_id,
						db,
						urlPatterns,
					);
					if (url === null) {
						return null;
					}
				} else {
					url = "#";
				}
		}
	} catch (error) {
		// If resolution fails, skip this item
		console.error(`Failed to resolve menu item ${item.id}:`, error);
		return null;
	}

	return {
		id: item.id,
		label: item.label,
		url: sanitizeHref(url),
		target: item.target || undefined,
		titleAttr: item.title_attr || undefined,
		cssClasses: item.css_classes || undefined,
		children: [], // Will be populated by buildMenuTree
	};
}

const SLUG_PLACEHOLDER = /\{slug\}/g;
const ID_PLACEHOLDER = /\{id\}/g;

/**
 * Interpolate a URL pattern with entry data
 *
 * Replaces `{slug}` and `{id}` placeholders.
 */
function interpolateUrlPattern(pattern: string, slug: string, id: string): string {
	return pattern.replace(SLUG_PLACEHOLDER, slug).replace(ID_PLACEHOLDER, id);
}

/**
 * Resolve URL for a content entry (page/post)
 *
 * Uses the collection's url_pattern if set, otherwise falls back to /{collection}/{slug}.
 * Returns null if content not found (item should be skipped).
 */
async function resolveContentUrl(
	collection: string,
	entryId: string | null,
	db: Kysely<Database>,
	urlPatterns: Map<string, string | null>,
): Promise<string | null> {
	if (!entryId) {
		return null;
	}

	try {
		// Dynamic content tables (ec_*) aren't in the Database type, so use sql
		const result = await sql<{ slug: string }>`
			SELECT slug FROM ${sql.ref(`ec_${collection}`)} WHERE id = ${entryId} LIMIT 1
		`.execute(db);

		const row = result.rows[0];
		if (row) {
			const pattern = urlPatterns.get(collection);
			if (pattern) {
				return interpolateUrlPattern(pattern, row.slug, entryId);
			}
			return `/${collection}/${row.slug}`;
		}

		// Content not found, skip item
		return null;
	} catch (error) {
		// Table might not exist or query failed
		console.error(`Failed to resolve content URL for ${collection}/${entryId}:`, error);
		return null;
	}
}

/**
 * Resolve URL for a taxonomy term
 *
 * Returns null if taxonomy not found (item should be skipped)
 */
async function resolveTaxonomyUrl(
	taxonomyId: string | null,
	db: Kysely<Database>,
): Promise<string | null> {
	if (!taxonomyId) {
		return null;
	}

	const taxonomy = await db
		.selectFrom("taxonomies")
		.select(["name", "slug"])
		.where("id", "=", taxonomyId)
		.executeTakeFirst();

	if (!taxonomy) {
		// Taxonomy not found, skip item
		return null;
	}

	// Use taxonomy name as base (e.g., "categories" or "tags")
	return `/${taxonomy.name}/${taxonomy.slug}`;
}
