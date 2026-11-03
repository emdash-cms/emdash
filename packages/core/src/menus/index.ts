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

import { menuTag } from "../cache/chrome-tags.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getLocaleChainRank, getLocaleRank } from "../i18n/config.js";
import { localeMatches } from "../i18n/query.js";
import {
	resolveLocalizedContentRoutePath,
	resolveLocale,
	resolveLocaleChain,
} from "../i18n/resolve.js";
import { getDb } from "../loader.js";
import {
	cachedQueryWithEpochs,
	CacheNamespace,
	contentCacheNamespaces,
	isObjectCacheActive,
} from "../object-cache/index.js";
import type { CacheHint } from "../query.js";
import { requestCached } from "../request-cache.js";
import { getRequestContext } from "../request-context.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { sanitizeHref } from "../utils/url.js";
import type { Menu, MenuItem, MenuItemRow } from "./types.js";

export interface MenuQueryOptions {
	/** Override the locale used for the lookup. When omitted, the locale comes
	 * from the request context or the configured defaultLocale. */
	locale?: string;
	/** Astro's route trailing-slash policy for resolved content links. */
	trailingSlash?: "always" | "never" | "ignore";
}

/** Per isolate: the namespaces each resolved menu was last cached under. */
const LAST_RESOLVED_NAMESPACES_KEY = Symbol.for("emdash:menu-resolved-namespaces");
const lastResolvedNamespaces: Map<string, string[]> =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
	((globalThis as Record<symbol, unknown>)[LAST_RESOLVED_NAMESPACES_KEY] as
		| Map<string, string[]>
		| undefined) ??
	(() => {
		const map = new Map<string, string[]>();
		(globalThis as Record<symbol, unknown>)[LAST_RESOLVED_NAMESPACES_KEY] = map;
		return map;
	})();

/**
 * Get a menu by name with resolved URLs.
 *
 * @example
 * ```ts
 * const menu = await getMenu("primary");
 * const menuEs = await getMenu("primary", { locale: "es" });
 * ```
 */
export async function getMenu(name: string, options: MenuQueryOptions = {}): Promise<Menu | null> {
	const locale = resolveLocale(options.locale);
	const trailingSlash = options.trailingSlash ?? (await getHostTrailingSlash());
	const key = `${name}:${locale ?? "*"}:${trailingSlash}`;
	return requestCached(`menu:${key}`, async () => {
		if (!(await isObjectCacheActive())) {
			return getMenuWithDb(name, await getDb(), { locale, trailingSlash });
		}
		const readRows = async () => {
			let epoch: number | undefined;
			const rows = await cachedQueryWithEpochs({
				namespace: CacheNamespace.MENUS,
				key: `rows:${name}:${locale ?? "*"}`,
				load: async () => loadMenuRows(name, await getDb(), locale),
				onEpochs: ([menus]) => {
					epoch = menus;
				},
			});
			return { rows, epoch };
		};
		const remembered = lastResolvedNamespaces.get(key);
		const earlyRead = remembered ? undefined : await readRows();
		const namespaces =
			remembered ?? (earlyRead?.rows && resolvedMenuNamespaces(earlyRead.rows.items));
		if (!namespaces) return null;
		let resolvedEpoch: number | undefined;
		let loaded: string[] | undefined;
		const menu = await cachedQueryWithEpochs<Menu | null>({
			namespace: namespaces,
			key,
			onEpochs: ([menus]) => {
				resolvedEpoch = menus;
			},
			// Rows read before this query captured its epochs are reused only if no menu
			// edit landed in between; otherwise the old items would be stored as current.
			load: async () => {
				const { rows } =
					earlyRead && earlyRead.epoch === resolvedEpoch ? earlyRead : await readRows();
				if (!rows) return null;
				loaded = resolvedMenuNamespaces(rows.items);
				return resolveMenu(rows, await getDb(), trailingSlash);
			},
			cacheable: (value) => value !== null && sameNamespaces(loaded, namespaces),
		});
		if (menu) lastResolvedNamespaces.set(key, loaded ?? namespaces);
		else lastResolvedNamespaces.delete(key);
		return menu;
	});
}

/**
 * Object-cache namespaces for a resolved menu: the menu epoch plus the content
 * epoch of every collection its items link to, and the taxonomy epoch when it
 * links to terms. Which links resolve depends on those rows, so publishing,
 * unpublishing, or trashing a linked entry invalidates the cached menu.
 */
function resolvedMenuNamespaces(items: MenuItemRow[]): string[] {
	const namespaces: string[] = [CacheNamespace.MENUS];
	for (const collection of collectContentReferences(items).keys()) {
		namespaces.push(...contentCacheNamespaces(collection));
	}
	if (items.some((item) => item.type === "taxonomy" && item.reference_id)) {
		namespaces.push(CacheNamespace.TAXONOMIES);
	}
	return namespaces;
}

function sameNamespaces(a: readonly string[] | undefined, b: readonly string[]): boolean {
	return a !== undefined && a.length === b.length && a.every((namespace, i) => namespace === b[i]);
}

async function getHostTrailingSlash(): Promise<"always" | "never" | "ignore"> {
	try {
		const config = (await import("virtual:emdash/config")) as {
			default?: { trailingSlash?: "always" | "never" | "ignore" };
		};
		return config.default?.trailingSlash ?? "ignore";
	} catch {
		return "ignore";
	}
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
	const rows = await loadMenuRows(name, db, options.locale);
	return rows && resolveMenu(rows, db, options.trailingSlash);
}

interface MenuRows {
	menu: Omit<Menu, "items">;
	items: MenuItemRow[];
}

async function loadMenuRows(
	name: string,
	db: Kysely<Database>,
	requestedLocale: string | undefined,
): Promise<MenuRows | null> {
	const chain = resolveLocaleChain(requestedLocale);

	let query = db
		.selectFrom("_emdash_menus as m")
		.leftJoin("_emdash_menu_items as i", "i.menu_id", "m.id")
		.selectAll("i")
		.select([
			"m.id as m_id",
			"m.name as m_name",
			"m.label as m_label",
			"m.locale as m_locale",
			"m.translation_group as m_translation_group",
		])
		.where("m.name", "=", name)
		.orderBy("i.sort_order", "asc");
	if (chain.length > 0) {
		query = query.where((eb) => eb.or(chain.map((locale) => localeMatches("m.locale", locale))));
	}
	const rows = await query.execute();
	const sortedRows = rows.toSorted((a, b) => {
		if (chain.length === 0)
			return a.m_locale.localeCompare(b.m_locale) || a.m_id.localeCompare(b.m_id);
		return (
			getLocaleChainRank(a.m_locale, chain) - getLocaleChainRank(b.m_locale, chain) ||
			a.m_id.localeCompare(b.m_id)
		);
	});
	const menuRow = sortedRows[0];
	if (!menuRow) return null;

	const menuId = menuRow.m_id;
	const itemRows = rows.filter(
		(row): row is typeof row & MenuItemRow => row.m_id === menuId && row.id !== null,
	);

	return {
		menu: {
			id: menuRow.m_id,
			name: menuRow.m_name,
			label: menuRow.m_label,
			locale: menuRow.m_locale,
			translationGroup: menuRow.m_translation_group,
		},
		items: itemRows,
	};
}

async function resolveMenu(
	rows: MenuRows,
	db: Kysely<Database>,
	trailingSlash: MenuQueryOptions["trailingSlash"],
): Promise<Menu> {
	return {
		...rows.menu,
		items: await buildMenuTree(rows.items, db, rows.menu.locale, trailingSlash),
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
	if (locale !== undefined) query = query.where(localeMatches("locale", locale));
	return query.execute();
}

/**
 * Get a menu by name with a Workers edge-cache hint.
 *
 * Use the returned `cacheHint` with `Astro.cache.set()` so pages that render
 * this menu can be purged automatically when the menu is edited.
 */
export async function getMenuWithCacheHint(
	name: string,
	options: MenuQueryOptions = {},
): Promise<{ data: Menu | null; cacheHint: CacheHint }> {
	const data = await getMenu(name, options);
	return { data, cacheHint: { tags: [menuTag(name)] } };
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
	trailingSlash?: "always" | "never" | "ignore",
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

	const resolvedItems = await Promise.all(
		items.map((item) =>
			resolveMenuItem(item, urlPatterns, contentLookup, taxonomyLookup, locale, trailingSlash),
		),
	);
	const validItems = resolvedItems.filter((item): item is MenuItem => item !== null);

	const itemMap = new Map<string, MenuItem & { children: MenuItem[] }>();
	const rootItems: MenuItem[] = [];
	const itemIds = new Set(items.map((item) => item.id));

	for (const item of validItems) {
		itemMap.set(item.id, { ...item, children: [] });
	}

	for (const item of items) {
		const menuItem = itemMap.get(item.id);
		if (!menuItem) continue;
		if (item.parent_id && itemIds.has(item.parent_id)) {
			itemMap.get(item.parent_id)?.children.push(menuItem);
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
async function resolveMenuItem(
	item: MenuItemRow,
	urlPatterns: Map<string, string | null>,
	contentLookup: ContentReferenceLookup,
	taxonomyLookup: TaxonomyReferenceLookup,
	locale: string,
	trailingSlash?: "always" | "never" | "ignore",
): Promise<MenuItem | null> {
	let url: string | null;

	switch (item.type) {
		case "custom":
			url = item.custom_url || "#";
			break;

		case "page":
		case "post":
			url = await resolveContentUrl(
				item.reference_collection || `${item.type}s`,
				item.reference_id,
				urlPatterns,
				contentLookup,
				locale,
				trailingSlash,
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
				url = await resolveContentUrl(
					item.reference_collection,
					item.reference_id,
					urlPatterns,
					contentLookup,
					locale,
					trailingSlash,
				);
				if (url === null) return null;
			} else {
				url = `/${item.reference_collection}/`;
			}
			break;

		default:
			if (item.reference_collection && item.reference_id) {
				url = await resolveContentUrl(
					item.reference_collection,
					item.reference_id,
					urlPatterns,
					contentLookup,
					locale,
					trailingSlash,
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

interface ContentReferenceRow {
	id: string;
	slug: string;
	published_at: string | null;
	locale: string;
	translation_group: string;
	status: string;
	deleted_at: string | null;
}

interface ResolvedContentReference {
	id: string;
	slug: string;
	publishedAt: string | null;
}

type ContentReferenceLookup = Map<string, Map<string, ResolvedContentReference>>;

async function resolveContentReferences(
	db: Kysely<Database>,
	references: Map<string, Set<string>>,
	locale: string,
): Promise<ContentReferenceLookup> {
	// Edit mode renders drafts, so a menu link to one still leads somewhere there.
	const editMode = getRequestContext()?.editMode === true;
	const isVisible = (row: { status: string; deleted_at: string | null }) =>
		row.deleted_at === null && (editMode || row.status === "published");
	const entries = await Promise.all(
		Array.from(references, async ([collection, referenceGroups]) => {
			const lookup = new Map<string, ResolvedContentReference>();
			const localized = new Map<string, ContentReferenceRow>();
			const found = new Set<string>();
			try {
				validateIdentifier(collection, "menu item collection");
				for (const batch of chunks([...referenceGroups], SQL_BATCH_SIZE)) {
					const result = await sql<ContentReferenceRow>`
						SELECT id, slug, published_at, locale, translation_group, status, deleted_at
						FROM ${sql.ref(`ec_${collection}`)}
						WHERE translation_group IN (${sql.join(batch)})
					`.execute(db);
					for (const row of result.rows) {
						// A hidden row still counts as found, so the legacy id lookup below is skipped.
						found.add(row.translation_group);
						if (!isVisible(row)) continue;
						const existing = localized.get(row.translation_group);
						if (shouldPreferLocalizedRow(row, existing, locale)) {
							localized.set(row.translation_group, row);
						}
					}
				}
				for (const [referenceGroup, row] of localized) {
					lookup.set(referenceGroup, { id: row.id, slug: row.slug, publishedAt: row.published_at });
				}

				const unresolved = [...referenceGroups].filter((id) => !found.has(id));
				for (const batch of chunks(unresolved, SQL_BATCH_SIZE)) {
					const result = await sql<
						Pick<ContentReferenceRow, "id" | "slug" | "published_at" | "status" | "deleted_at">
					>`
						SELECT id, slug, published_at, status, deleted_at FROM ${sql.ref(`ec_${collection}`)}
						WHERE id IN (${sql.join(batch)})
					`.execute(db);
					for (const row of result.rows) {
						if (!isVisible(row)) continue;
						lookup.set(row.id, { id: row.id, slug: row.slug, publishedAt: row.published_at });
					}
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
	const candidateRank = getLocaleRank(candidate.locale, locale);
	const existingRank = getLocaleRank(existing.locale, locale);
	return (
		candidateRank < existingRank ||
		(candidateRank === existingRank &&
			(candidate.locale < existing.locale ||
				(candidate.locale === existing.locale && candidate.id < existing.id)))
	);
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
	urlPatterns: Map<string, string | null>,
	contentLookup: ContentReferenceLookup,
	locale: string,
	trailingSlash?: "always" | "never" | "ignore",
): Promise<string | null> {
	if (!referenceGroup) return null;
	const row = contentLookup.get(collection)?.get(referenceGroup);
	if (!row) return null;
	return resolveLocalizedContentRoutePath({
		pattern: urlPatterns.get(collection) ?? null,
		collection,
		slug: row.slug,
		id: row.id,
		date: row.publishedAt,
		locale,
		trailingSlash,
	});
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
