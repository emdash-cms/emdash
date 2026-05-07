/**
 * Navigation menu runtime functions.
 *
 * These are called from templates to query menus and resolve URLs. All queries
 * are locale-aware: when a locale is configured (or passed explicitly) items
 * are filtered to that locale, and menu item references resolve against the
 * referenced content's translation_group so the URL points at the right
 * per-locale row.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { resolveLocale, resolveLocaleChain } from "../i18n/resolve.js";
import { getDb } from "../loader.js";
import { requestCached } from "../request-cache.js";
import { sanitizeHref } from "../utils/url.js";
import type { Menu, MenuItem, MenuItemRow } from "./types.js";

export interface MenuQueryOptions {
	/** Override the locale used for the lookup. When omitted, the locale comes
	 * from the request context or the configured defaultLocale. */
	locale?: string;
}

/**
 * Get a menu by name with resolved URLs.
 *
 * @example
 * ```ts
 * const menu = await getMenu("primary");
 * const menuEs = await getMenu("primary", { locale: "es" });
 * ```
 */
export function getMenu(name: string, options: MenuQueryOptions = {}): Promise<Menu | null> {
	const locale = resolveLocale(options.locale);
	return requestCached(`menu:${name}:${locale ?? "*"}`, async () => {
		const db = await getDb();
		return getMenuWithDb(name, db, { locale });
	});
}

/**
 * Get menu by name with resolved URLs (with explicit db). Internal helper for
 * admin routes that already have a database handle.
 */
export async function getMenuWithDb(
	name: string,
	db: Kysely<Database>,
	options: MenuQueryOptions = {},
): Promise<Menu | null> {
	const chain = resolveLocaleChain(options.locale);

	const selectMenu = () => db.selectFrom("_emdash_menus").selectAll().where("name", "=", name);

	let menuRow: Awaited<ReturnType<ReturnType<typeof selectMenu>["executeTakeFirst"]>>;
	if (chain.length === 0) {
		menuRow = await selectMenu().orderBy("locale", "asc").executeTakeFirst();
	} else {
		menuRow = undefined;
		for (const locale of chain) {
			menuRow = await selectMenu().where("locale", "=", locale).executeTakeFirst();
			if (menuRow) break;
		}
	}

	if (!menuRow) return null;

	const itemRows = await db
		.selectFrom("_emdash_menu_items")
		.selectAll()
		.$castTo<MenuItemRow>()
		.where("menu_id", "=", menuRow.id)
		.orderBy("sort_order", "asc")
		.execute();

	const items = await buildMenuTree(itemRows, db, menuRow.locale);

	return {
		id: menuRow.id,
		name: menuRow.name,
		label: menuRow.label,
		items,
		locale: menuRow.locale,
		translationGroup: menuRow.translation_group,
	};
}

/**
 * Get all menus (without items, locale-filtered — for admin list / site nav
 * summaries). When no locale is configured, returns menus across all locales.
 */
export async function getMenus(
	options: MenuQueryOptions = {},
): Promise<Array<{ id: string; name: string; label: string; locale: string }>> {
	const db = await getDb();
	return getMenusWithDb(db, options);
}

/**
 * Get all menus (with explicit db)
 *
 * @internal Use `getMenus()` in templates. This variant is for admin routes
 * that already have a database handle.
 */
export async function getMenusWithDb(
	db: Kysely<Database>,
	options: MenuQueryOptions = {},
): Promise<Array<{ id: string; name: string; label: string; locale: string }>> {
	const locale = resolveLocale(options.locale);
	let query = db
		.selectFrom("_emdash_menus")
		.select(["id", "name", "label", "locale"])
		.orderBy("name", "asc");
	if (locale !== undefined) query = query.where("locale", "=", locale);
	return query.execute();
}

/**
 * Build a hierarchical menu tree from a flat list of items. Items are
 * resolved against the given `locale` so references land on the right
 * per-locale content rows.
 */
async function buildMenuTree(
	items: MenuItemRow[],
	db: Kysely<Database>,
	locale: string,
): Promise<MenuItem[]> {
	const collectionSlugs = new Set<string>();
	for (const item of items) {
		if (item.reference_collection) collectionSlugs.add(item.reference_collection);
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
		for (const row of rows) urlPatterns.set(row.slug, row.url_pattern);
	}

	const resolvedItems = await Promise.all(
		items.map((item) => resolveMenuItem(item, db, urlPatterns, locale)),
	);
	const validItems = resolvedItems.filter((item): item is MenuItem => item !== null);

	const itemMap = new Map<string, MenuItem & { children: MenuItem[] }>();
	const rootItems: MenuItem[] = [];

	for (const item of validItems) {
		itemMap.set(item.id, { ...item, children: [] });
	}

	for (const item of items) {
		const menuItem = itemMap.get(item.id);
		if (!menuItem) continue;
		if (item.parent_id) {
			const parent = itemMap.get(item.parent_id);
			if (parent) parent.children.push(menuItem);
			else rootItems.push(menuItem);
		} else {
			rootItems.push(menuItem);
		}
	}

	return rootItems;
}

/**
 * Resolve a single menu item's URL. `reference_id` is a translation_group
 * (migration 036 remapped all existing references); we join it against
 * the per-locale ec_* row or per-locale taxonomy row.
 */
async function resolveMenuItem(
	item: MenuItemRow,
	db: Kysely<Database>,
	urlPatterns: Map<string, string | null>,
	locale: string,
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
					item.reference_collection || `${item.type}s`,
					item.reference_id,
					db,
					urlPatterns,
					locale,
				);
				if (url === null) return null;
				break;

			case "taxonomy":
				url = await resolveTaxonomyUrl(item.reference_id, db, locale);
				if (url === null) return null;
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
						locale,
					);
					if (url === null) return null;
				} else {
					url = "#";
				}
		}
	} catch (error) {
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
		children: [],
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
 * Resolve the URL for a content reference. `referenceGroup` is the content
 * row's translation_group; we look up the row in the requested locale
 * (falling back to the source if no translation exists so the menu link is
 * still clickable).
 */
async function resolveContentUrl(
	collection: string,
	referenceGroup: string | null,
	db: Kysely<Database>,
	urlPatterns: Map<string, string | null>,
	locale: string,
): Promise<string | null> {
	if (!referenceGroup) return null;

	try {
		validateIdentifier(collection, "menu item collection");

		// Try the requested locale first, then any locale (deterministic).
		let result = await sql<{ id: string; slug: string }>`
			SELECT id, slug FROM ${sql.ref(`ec_${collection}`)}
			WHERE translation_group = ${referenceGroup} AND locale = ${locale}
			LIMIT 1
		`.execute(db);
		let row = result.rows[0];
		if (!row) {
			result = await sql<{ id: string; slug: string }>`
				SELECT id, slug FROM ${sql.ref(`ec_${collection}`)}
				WHERE translation_group = ${referenceGroup}
				ORDER BY locale ASC LIMIT 1
			`.execute(db);
			row = result.rows[0];
		}
		if (!row) {
			// Legacy rows whose reference_id still points at an id directly
			// (defensive — migration 036 normalised these, but a row inserted
			// between migrations could predate the remap).
			const legacy = await sql<{ id: string; slug: string }>`
				SELECT id, slug FROM ${sql.ref(`ec_${collection}`)}
				WHERE id = ${referenceGroup} LIMIT 1
			`.execute(db);
			row = legacy.rows[0];
		}
		if (!row) return null;

		const pattern = urlPatterns.get(collection);
		if (pattern) return interpolateUrlPattern(pattern, row.slug, row.id);
		return `/${collection}/${row.slug}`;
	} catch (error) {
		console.error(`Failed to resolve content URL for ${collection}/${referenceGroup}:`, error);
		return null;
	}
}

/**
 * Resolve URL for a taxonomy term reference. `referenceGroup` is the term's
 * translation_group; we pick the row in the active locale (or fall back).
 */
async function resolveTaxonomyUrl(
	referenceGroup: string | null,
	db: Kysely<Database>,
	locale: string,
): Promise<string | null> {
	if (!referenceGroup) return null;

	let taxonomy = await db
		.selectFrom("taxonomies")
		.select(["name", "slug"])
		.where("translation_group", "=", referenceGroup)
		.where("locale", "=", locale)
		.executeTakeFirst();

	if (!taxonomy) {
		taxonomy = await db
			.selectFrom("taxonomies")
			.select(["name", "slug"])
			.where("translation_group", "=", referenceGroup)
			.orderBy("locale", "asc")
			.executeTakeFirst();
	}

	if (!taxonomy) {
		// Legacy: id-based reference that predates the migration remap.
		taxonomy = await db
			.selectFrom("taxonomies")
			.select(["name", "slug"])
			.where("id", "=", referenceGroup)
			.executeTakeFirst();
	}

	if (!taxonomy) return null;

	return `/${taxonomy.name}/${taxonomy.slug}`;
}
