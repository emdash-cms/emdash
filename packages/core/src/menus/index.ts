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
import { cachedQuery, CacheNamespace } from "../object-cache/index.js";
import { requestCached } from "../request-cache.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
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
	return requestCached(`menu:${name}:${locale ?? "*"}`, () =>
		cachedQuery({
			namespace: CacheNamespace.MENUS,
			key: `${name}:${locale ?? "*"}`,
			load: async () => {
				const db = await getDb();
				return getMenuWithDb(name, db, { locale });
			},
		}),
	);
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
	const contentReferences = collectContentReferences(items);
	const taxonomyReferences = new Set(
		items.flatMap((item) =>
			item.type === "taxonomy" && item.reference_id ? [item.reference_id] : [],
		),
	);
	const [urlPatterns, contentLookup, taxonomyLookup] = await Promise.all([
		contentReferences.size > 0
			? getCollectionUrlPatterns(db, new Set(contentReferences.keys()))
			: new Map<string, string | null>(),
		resolveContentReferences(db, contentReferences, locale),
		resolveTaxonomyReferences(db, taxonomyReferences, locale),
	]);

	const resolvedItems = items.map((item) =>
		resolveMenuItem(item, urlPatterns, contentLookup, taxonomyLookup),
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

function collectContentReferences(items: MenuItemRow[]): Map<string, Set<string>> {
	const references = new Map<string, Set<string>>();
	for (const item of items) {
		const reference = getContentReference(item);
		if (!reference) continue;
		let ids = references.get(reference.collection);
		if (!ids) {
			ids = new Set();
			references.set(reference.collection, ids);
		}
		ids.add(reference.id);
	}
	return references;
}

function getContentReference(item: MenuItemRow): { collection: string; id: string } | null {
	if (item.type === "page" || item.type === "post") {
		if (!item.reference_id) return null;
		return {
			collection: item.reference_collection || `${item.type}s`,
			id: item.reference_id,
		};
	}
	if (item.type === "collection") {
		if (!item.reference_collection || !item.reference_id) return null;
		return { collection: item.reference_collection, id: item.reference_id };
	}
	if (
		item.type !== "custom" &&
		item.type !== "taxonomy" &&
		item.reference_collection &&
		item.reference_id
	) {
		return { collection: item.reference_collection, id: item.reference_id };
	}
	return null;
}

/**
 * Look up the `url_pattern` for a set of collection slugs, request-cached so
 * a page rendering several menus (header, footer, ...) only pays for the
 * lookup once per distinct slug set. Callers must treat the returned map as
 * read-only — it is shared across cache hits within the request.
 */
function getCollectionUrlPatterns(
	db: Kysely<Database>,
	collectionSlugs: Set<string>,
): Promise<Map<string, string | null>> {
	const key = `menu-collection-patterns:${[...collectionSlugs].toSorted().join(",")}`;
	return requestCached(key, async () => {
		const rows = await db
			.selectFrom("_emdash_collections")
			.select(["slug", "url_pattern"])
			.where("slug", "in", [...collectionSlugs])
			.execute();
		const urlPatterns = new Map<string, string | null>();
		for (const row of rows) urlPatterns.set(row.slug, row.url_pattern);
		return urlPatterns;
	});
}

/**
 * Resolve a single menu item's URL. `reference_id` is a translation_group
 * (migration 036 remapped all existing references); we look it up against
 * the per-locale ec_* row or per-locale taxonomy row.
 */
function resolveMenuItem(
	item: MenuItemRow,
	urlPatterns: Map<string, string | null>,
	contentLookup: ContentReferenceLookup,
	taxonomyLookup: TaxonomyReferenceLookup,
): MenuItem | null {
	let url: string | null;

	switch (item.type) {
		case "custom":
			url = item.custom_url || "#";
			break;

		case "page":
		case "post":
			url = resolveContentUrl(
				item.reference_collection || `${item.type}s`,
				item.reference_id,
				urlPatterns,
				contentLookup,
			);
			if (url === null) return null;
			break;

		case "taxonomy":
			url = resolveTaxonomyUrl(item.reference_id, taxonomyLookup);
			if (url === null) return null;
			break;

		case "collection":
			// Two shapes share this type: the admin content picker stores
			// entries from custom collections as "collection" with a
			// reference_id, while archive links carry only the collection
			// slug. Entry references resolve like page/post items.
			if (!item.reference_collection) return null;
			if (item.reference_id) {
				url = resolveContentUrl(
					item.reference_collection,
					item.reference_id,
					urlPatterns,
					contentLookup,
				);
				if (url === null) return null;
			} else {
				url = `/${item.reference_collection}/`;
			}
			break;

		default:
			if (item.reference_collection && item.reference_id) {
				url = resolveContentUrl(
					item.reference_collection,
					item.reference_id,
					urlPatterns,
					contentLookup,
				);
				if (url === null) return null;
			} else {
				url = "#";
			}
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

interface ContentReferenceRow {
	id: string;
	slug: string;
	locale: string;
	translation_group: string;
}

interface ResolvedContentReference {
	id: string;
	slug: string;
}

type ContentReferenceLookup = Map<string, Map<string, ResolvedContentReference>>;

async function resolveContentReferences(
	db: Kysely<Database>,
	references: Map<string, Set<string>>,
	locale: string,
): Promise<ContentReferenceLookup> {
	const entries = await Promise.all(
		Array.from(references, async ([collection, referenceGroups]) => {
			const lookup = new Map<string, ResolvedContentReference>();
			const localized = new Map<string, ContentReferenceRow>();
			try {
				validateIdentifier(collection, "menu item collection");
				for (const batch of chunks([...referenceGroups], SQL_BATCH_SIZE)) {
					const result = await sql<ContentReferenceRow>`
						SELECT id, slug, locale, translation_group
						FROM ${sql.ref(`ec_${collection}`)}
						WHERE translation_group IN (${sql.join(batch)})
					`.execute(db);
					for (const row of result.rows) {
						const existing = localized.get(row.translation_group);
						if (shouldPreferLocalizedRow(row, existing, locale)) {
							localized.set(row.translation_group, row);
						}
					}
				}
				for (const [referenceGroup, row] of localized) {
					lookup.set(referenceGroup, { id: row.id, slug: row.slug });
				}

				const unresolved = [...referenceGroups].filter((id) => !lookup.has(id));
				for (const batch of chunks(unresolved, SQL_BATCH_SIZE)) {
					const result = await sql<ResolvedContentReference>`
						SELECT id, slug FROM ${sql.ref(`ec_${collection}`)}
						WHERE id IN (${sql.join(batch)})
					`.execute(db);
					for (const row of result.rows) lookup.set(row.id, row);
				}
			} catch (error) {
				console.error(`Failed to resolve content URLs for ${collection}:`, error);
			}
			return [collection, lookup] as const;
		}),
	);
	return new Map(entries);
}

interface LocalizedReference {
	id: string;
	locale: string;
}

function shouldPreferLocalizedRow(
	candidate: LocalizedReference,
	existing: LocalizedReference | undefined,
	locale: string,
): boolean {
	if (!existing) return true;
	if (candidate.locale === locale) return existing.locale !== locale || candidate.id < existing.id;
	if (existing.locale === locale) return false;
	return (
		candidate.locale < existing.locale ||
		(candidate.locale === existing.locale && candidate.id < existing.id)
	);
}

/**
 * Resolve the URL for a content reference. `referenceGroup` is the content
 * row's translation_group; we look up the row in the requested locale
 * (falling back to the source if no translation exists so the menu link is
 * still clickable).
 */
function resolveContentUrl(
	collection: string,
	referenceGroup: string | null,
	urlPatterns: Map<string, string | null>,
	contentLookup: ContentReferenceLookup,
): string | null {
	if (!referenceGroup) return null;
	const row = contentLookup.get(collection)?.get(referenceGroup);
	if (!row) return null;
	const pattern = urlPatterns.get(collection);
	if (pattern) return interpolateUrlPattern(pattern, row.slug, row.id);
	return `/${collection}/${row.slug}`;
}

interface TaxonomyReferenceRow {
	id: string;
	name: string;
	slug: string;
	locale: string;
	translation_group: string;
}

interface ResolvedTaxonomyReference {
	name: string;
	slug: string;
}

type TaxonomyReferenceLookup = Map<string, ResolvedTaxonomyReference>;

async function resolveTaxonomyReferences(
	db: Kysely<Database>,
	referenceGroups: Set<string>,
	locale: string,
): Promise<TaxonomyReferenceLookup> {
	const lookup = new Map<string, ResolvedTaxonomyReference>();
	const localized = new Map<string, TaxonomyReferenceRow>();
	try {
		for (const batch of chunks([...referenceGroups], SQL_BATCH_SIZE)) {
			const rows = await db
				.selectFrom("taxonomies")
				.select(["id", "name", "slug", "locale", "translation_group"])
				.where("translation_group", "in", batch)
				.$narrowType<{ translation_group: string }>()
				.execute();
			for (const row of rows) {
				const existing = localized.get(row.translation_group);
				if (shouldPreferLocalizedRow(row, existing, locale)) {
					localized.set(row.translation_group, row);
				}
			}
		}
		for (const [referenceGroup, row] of localized) {
			lookup.set(referenceGroup, { name: row.name, slug: row.slug });
		}

		const unresolved = [...referenceGroups].filter((id) => !lookup.has(id));
		for (const batch of chunks(unresolved, SQL_BATCH_SIZE)) {
			const rows = await db
				.selectFrom("taxonomies")
				.select(["id", "name", "slug"])
				.where("id", "in", batch)
				.execute();
			for (const row of rows) lookup.set(row.id, { name: row.name, slug: row.slug });
		}
	} catch (error) {
		console.error("Failed to resolve taxonomy URLs:", error);
	}
	return lookup;
}

/**
 * Resolve URL for a taxonomy term reference. `referenceGroup` is the term's
 * translation_group; we pick the row in the active locale (or fall back).
 */
function resolveTaxonomyUrl(
	referenceGroup: string | null,
	taxonomyLookup: TaxonomyReferenceLookup,
): string | null {
	if (!referenceGroup) return null;
	const taxonomy = taxonomyLookup.get(referenceGroup);
	if (!taxonomy) return null;
	return `/${taxonomy.name}/${taxonomy.slug}`;
}
