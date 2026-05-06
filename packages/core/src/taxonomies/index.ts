/**
 * Runtime API for taxonomies.
 *
 * All helpers are locale-aware. When a locale is not passed explicitly we fall
 * back to the request context or the configured `defaultLocale` (see
 * `i18n/resolve.ts`).
 *
 * Because `content_taxonomies.taxonomy_id` stores the translation_group (not a
 * specific term id), the joins here are `taxonomies.translation_group =
 * content_taxonomies.taxonomy_id` + filter by `taxonomies.locale`, which picks
 * the right per-locale term.
 */

import { resolveLocale, resolveLocaleChain } from "../i18n/resolve.js";
import { getDb } from "../loader.js";
import { peekRequestCache, requestCached, setRequestCacheEntry } from "../request-cache.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { isMissingTableError } from "../utils/db-errors.js";
import type { TaxonomyDef, TaxonomyTerm, TaxonomyTermRow } from "./types.js";

export interface TaxonomyQueryOptions {
	locale?: string;
}

/**
 * No-op — kept for API compatibility.
 */
export function invalidateTermCache(): void {
	// Intentionally empty.
}

/**
 * Get every taxonomy definition. Definitions are per-locale (one row per
 * locale inside the same translation_group) — by default we resolve to the
 * active locale.
 */
export async function getTaxonomyDefs(options: TaxonomyQueryOptions = {}): Promise<TaxonomyDef[]> {
	const locale = resolveLocale(options.locale);
	return requestCached(`taxonomy-defs:${locale ?? "*"}`, async () => {
		const db = await getDb();
		let query = db.selectFrom("_emdash_taxonomy_defs").selectAll();
		if (locale !== undefined) query = query.where("locale", "=", locale);
		const rows = await query.execute();
		return rows.map(rowToTaxonomyDef);
	});
}

/**
 * Get a single taxonomy definition by name. Uses the fallback chain so even
 * if there is no translation for the active locale we still return something.
 *
 * If `getTaxonomyDefs()` has already loaded the full list in this request
 * (which happens during entry-term hydration on every page that renders a
 * collection), search the matching def in memory rather than running a
 * second query against `_emdash_taxonomy_defs`.
 */
export async function getTaxonomyDef(
	name: string,
	options: TaxonomyQueryOptions = {},
): Promise<TaxonomyDef | null> {
	const chain = resolveLocaleChain(options.locale);
	const peekKey = `taxonomy-defs:${resolveLocale(options.locale) ?? "*"}`;
	const allDefs = peekRequestCache<TaxonomyDef[]>(peekKey);
	if (allDefs) {
		const defs = await allDefs;
		if (chain.length === 0) return defs.find((d) => d.name === name) ?? null;
		for (const locale of chain) {
			const found = defs.find((d) => d.name === name && d.locale === locale);
			if (found) return found;
		}
		return null;
	}

	return requestCached(`taxonomy-def:${name}:${chain.join(",")}`, async () => {
		const db = await getDb();

		if (chain.length === 0) {
			const row = await db
				.selectFrom("_emdash_taxonomy_defs")
				.selectAll()
				.where("name", "=", name)
				.orderBy("locale", "asc")
				.executeTakeFirst();
			return row ? rowToTaxonomyDef(row) : null;
		}

		for (const locale of chain) {
			const row = await db
				.selectFrom("_emdash_taxonomy_defs")
				.selectAll()
				.where("name", "=", name)
				.where("locale", "=", locale)
				.executeTakeFirst();
			if (row) return rowToTaxonomyDef(row);
		}
		return null;
	});
}

/**
 * All terms of a taxonomy in a specific locale (flat for non-hierarchical,
 * tree for hierarchical).
 */
export async function getTaxonomyTerms(
	taxonomyName: string,
	options: TaxonomyQueryOptions = {},
): Promise<TaxonomyTerm[]> {
	const locale = resolveLocale(options.locale);
	return requestCached(`taxonomy-terms:${taxonomyName}:${locale ?? "*"}`, async () => {
		const db = await getDb();

		const def = await getTaxonomyDef(taxonomyName, options);
		if (!def) return [];

		let termsQuery = db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", taxonomyName)
			.orderBy("label", "asc");
		if (locale !== undefined) termsQuery = termsQuery.where("locale", "=", locale);
		const rows = await termsQuery.execute();

		// Counts are keyed by translation_group (what the pivot stores).
		const countsResult = await db
			.selectFrom("content_taxonomies")
			.select(["taxonomy_id"])
			.select((eb) => eb.fn.count<number>("entry_id").as("count"))
			.groupBy("taxonomy_id")
			.execute();
		const counts = new Map<string, number>();
		for (const row of countsResult) counts.set(row.taxonomy_id, row.count);

		const flatTerms: TaxonomyTermRow[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			slug: row.slug,
			label: row.label,
			parent_id: row.parent_id,
			data: row.data,
			locale: row.locale,
			translation_group: row.translation_group,
		}));

		if (def.hierarchical) return buildTree(flatTerms, counts);

		return flatTerms.map((term) => ({
			id: term.id,
			name: term.name,
			slug: term.slug,
			label: term.label,
			children: [],
			count: counts.get(term.translation_group ?? term.id) ?? 0,
			locale: term.locale,
			translationGroup: term.translation_group,
		}));
	});
}

/**
 * Get a single term by (taxonomy, slug). Honours the fallback chain — if the
 * slug exists in a fallback locale, we return that row (useful for deep-linking
 * to a term page when the translation is missing).
 */
export async function getTerm(
	taxonomyName: string,
	slug: string,
	options: TaxonomyQueryOptions = {},
): Promise<TaxonomyTerm | null> {
	const db = await getDb();
	const chain = resolveLocaleChain(options.locale);

	let row: Awaited<ReturnType<ReturnType<typeof selectTerm>["executeTakeFirst"]>>;
	const selectTerm = () =>
		db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", taxonomyName)
			.where("slug", "=", slug);

	if (chain.length === 0) {
		row = await selectTerm().orderBy("locale", "asc").executeTakeFirst();
	} else {
		row = undefined;
		for (const locale of chain) {
			row = await selectTerm().where("locale", "=", locale).executeTakeFirst();
			if (row) break;
		}
	}

	if (!row) return null;

	const countResult = await db
		.selectFrom("content_taxonomies")
		.select((eb) => eb.fn.count<number>("entry_id").as("count"))
		.where("taxonomy_id", "=", row.translation_group ?? row.id)
		.executeTakeFirst();
	const count = countResult?.count ?? 0;

	let childrenQuery = db
		.selectFrom("taxonomies")
		.selectAll()
		.where("parent_id", "=", row.id)
		.orderBy("label", "asc");
	const termLocale = row.locale;
	if (termLocale) childrenQuery = childrenQuery.where("locale", "=", termLocale);
	const childRows = await childrenQuery.execute();

	const children = childRows.map<TaxonomyTerm>((child) => ({
		id: child.id,
		name: child.name,
		slug: child.slug,
		label: child.label,
		parentId: child.parent_id ?? undefined,
		children: [],
		locale: child.locale,
		translationGroup: child.translation_group,
	}));

	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		label: row.label,
		parentId: row.parent_id ?? undefined,
		description: row.data ? JSON.parse(row.data).description : undefined,
		children,
		count,
		locale: row.locale,
		translationGroup: row.translation_group,
	};
}

/**
 * Terms assigned to a content entry, resolved into the active locale. Terms
 * whose translation_group lacks a row in the requested locale are omitted.
 */
export function getEntryTerms(
	collection: string,
	entryId: string,
	taxonomyName?: string,
	options: TaxonomyQueryOptions = {},
): Promise<TaxonomyTerm[]> {
	const locale = resolveLocale(options.locale);
	return requestCached(
		`terms:${collection}:${entryId}:${taxonomyName ?? "*"}:${locale ?? "*"}`,
		async () => {
			const db = await getDb();

			let query = db
				.selectFrom("content_taxonomies")
				.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
				.selectAll("taxonomies")
				.where("content_taxonomies.collection", "=", collection)
				.where("content_taxonomies.entry_id", "=", entryId);

			if (taxonomyName) query = query.where("taxonomies.name", "=", taxonomyName);
			if (locale !== undefined) query = query.where("taxonomies.locale", "=", locale);

			const rows = await query.execute();
			return rows.map<TaxonomyTerm>((row) => ({
				id: row.id,
				name: row.name,
				slug: row.slug,
				label: row.label,
				parentId: row.parent_id ?? undefined,
				children: [],
				locale: row.locale,
				translationGroup: row.translation_group,
			}));
		},
	);
}

/**
 * Terms for multiple entries of one taxonomy, single query.
 */
export async function getTermsForEntries(
	collection: string,
	entryIds: string[],
	taxonomyName: string,
	options: TaxonomyQueryOptions = {},
): Promise<Map<string, TaxonomyTerm[]>> {
	const result = new Map<string, TaxonomyTerm[]>();
	const uniqueIds = [...new Set(entryIds)];
	for (const id of uniqueIds) result.set(id, []);
	if (uniqueIds.length === 0) return result;

	const db = await getDb();
	const locale = resolveLocale(options.locale);

	for (const chunk of chunks(uniqueIds, SQL_BATCH_SIZE)) {
		let rows;
		try {
			let query = db
				.selectFrom("content_taxonomies")
				.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
				.select([
					"content_taxonomies.entry_id",
					"taxonomies.id",
					"taxonomies.name",
					"taxonomies.slug",
					"taxonomies.label",
					"taxonomies.parent_id",
					"taxonomies.locale",
					"taxonomies.translation_group",
				])
				.where("content_taxonomies.collection", "=", collection)
				.where("content_taxonomies.entry_id", "in", chunk)
				.where("taxonomies.name", "=", taxonomyName);
			if (locale !== undefined) query = query.where("taxonomies.locale", "=", locale);
			rows = await query.execute();
		} catch (error) {
			if (isMissingTableError(error)) return result;
			throw error;
		}

		for (const row of rows) {
			const term: TaxonomyTerm = {
				id: row.id,
				name: row.name,
				slug: row.slug,
				label: row.label,
				parentId: row.parent_id ?? undefined,
				children: [],
				locale: row.locale,
				translationGroup: row.translation_group,
			};
			const terms = result.get(row.entry_id);
			if (terms) terms.push(term);
		}
	}

	return result;
}

/**
 * Batch-fetch terms for multiple entries across ALL taxonomies in one query.
 * Primes the request-cache for subsequent per-entry calls to `getEntryTerms`.
 */
export async function getAllTermsForEntries(
	collection: string,
	entryIds: string[],
	options: TaxonomyQueryOptions = {},
): Promise<Map<string, Record<string, TaxonomyTerm[]>>> {
	const result = new Map<string, Record<string, TaxonomyTerm[]>>();
	const uniqueIds = [...new Set(entryIds)];
	for (const id of uniqueIds) result.set(id, {});
	if (uniqueIds.length === 0) return result;

	const db = await getDb();
	const locale = resolveLocale(options.locale);
	const applicableTaxonomyNames = await getCollectionTaxonomyNames(collection, { locale });

	for (const chunk of chunks(uniqueIds, SQL_BATCH_SIZE)) {
		let rows;
		try {
			let query = db
				.selectFrom("content_taxonomies")
				.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
				.select([
					"content_taxonomies.entry_id",
					"taxonomies.id",
					"taxonomies.name",
					"taxonomies.slug",
					"taxonomies.label",
					"taxonomies.parent_id",
					"taxonomies.locale",
					"taxonomies.translation_group",
				])
				.where("content_taxonomies.collection", "=", collection)
				.where("content_taxonomies.entry_id", "in", chunk)
				.orderBy("taxonomies.label", "asc");
			if (locale !== undefined) query = query.where("taxonomies.locale", "=", locale);
			rows = await query.execute();
		} catch (error) {
			if (isMissingTableError(error)) {
				for (const id of uniqueIds) {
					primeEntryTermsCache(collection, id, {}, applicableTaxonomyNames, locale);
				}
				return result;
			}
			throw error;
		}

		for (const row of rows) {
			const term: TaxonomyTerm = {
				id: row.id,
				name: row.name,
				slug: row.slug,
				label: row.label,
				parentId: row.parent_id ?? undefined,
				children: [],
				locale: row.locale,
				translationGroup: row.translation_group,
			};
			const byTaxonomy = result.get(row.entry_id);
			if (!byTaxonomy) continue;
			const existing = byTaxonomy[row.name];
			if (existing) existing.push(term);
			else byTaxonomy[row.name] = [term];
		}
	}

	for (const [entryId, byTaxonomy] of result) {
		primeEntryTermsCache(collection, entryId, byTaxonomy, applicableTaxonomyNames, locale);
	}

	return result;
}

/**
 * Return the list of taxonomy names applicable to a collection, request-
 * cached so a page render only pays for it once.
 *
 * Returns an empty list when taxonomies haven't been defined yet.
 */
async function getCollectionTaxonomyNames(
	collection: string,
	options: TaxonomyQueryOptions,
): Promise<string[]> {
	try {
		const defs = await getTaxonomyDefs(options);
		return defs.filter((d) => d.collections.includes(collection)).map((d) => d.name);
	} catch (error) {
		if (isMissingTableError(error)) return [];
		throw error;
	}
}

/**
 * Pre-populate the request-cache for every getEntryTerms call-shape that
 * could hit this entry:
 *
 *   getEntryTerms(collection, entryId)                 -> key `terms:C:E:*`
 *   getEntryTerms(collection, entryId, "tag")          -> key `terms:C:E:tag`
 *   getEntryTerms(collection, entryId, "category")     -> key `terms:C:E:category`
 *   ...one per taxonomy that applies to this collection
 *
 * Taxonomies with no rows on this entry are seeded with `[]` so legacy
 * callers short-circuit to the cached empty array instead of re-querying.
 */
function primeEntryTermsCache(
	collection: string,
	entryId: string,
	byTaxonomy: Record<string, TaxonomyTerm[]>,
	applicableTaxonomyNames: string[],
	locale: string | undefined,
): void {
	const localeKey = locale ?? "*";
	for (const name of applicableTaxonomyNames) {
		setRequestCacheEntry(
			`terms:${collection}:${entryId}:${name}:${localeKey}`,
			byTaxonomy[name] ?? [],
		);
	}
	for (const [name, terms] of Object.entries(byTaxonomy)) {
		setRequestCacheEntry(`terms:${collection}:${entryId}:${name}:${localeKey}`, terms);
	}
	const allTerms = Object.values(byTaxonomy).flat();
	setRequestCacheEntry(`terms:${collection}:${entryId}:*:${localeKey}`, allTerms);
}

/**
 * Get entries by term. Both the lookup (term slug in the active locale) and
 * the content query respect the active locale.
 */
export async function getEntriesByTerm(
	collection: string,
	taxonomyName: string,
	termSlug: string,
	options: TaxonomyQueryOptions = {},
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
	const { getEmDashCollection } = await import("../query.js");

	const queryOptions: Record<string, unknown> = {
		where: { [taxonomyName]: termSlug },
	};
	if (options.locale !== undefined) queryOptions.locale = options.locale;
	const { entries } = await getEmDashCollection(collection, queryOptions);
	return entries;
}

function rowToTaxonomyDef(row: {
	id: string;
	name: string;
	label: string;
	label_singular: string | null;
	hierarchical: number;
	collections: string | null;
	locale: string;
	translation_group: string | null;
}): TaxonomyDef {
	return {
		id: row.id,
		name: row.name,
		label: row.label,
		labelSingular: row.label_singular ?? undefined,
		hierarchical: row.hierarchical === 1,
		collections: row.collections ? JSON.parse(row.collections) : [],
		locale: row.locale,
		translationGroup: row.translation_group,
	};
}

/**
 * Build tree structure from flat terms
 */
function buildTree(flatTerms: TaxonomyTermRow[], counts: Map<string, number>): TaxonomyTerm[] {
	const map = new Map<string, TaxonomyTerm>();
	const roots: TaxonomyTerm[] = [];

	for (const term of flatTerms) {
		map.set(term.id, {
			id: term.id,
			name: term.name,
			slug: term.slug,
			label: term.label,
			parentId: term.parent_id ?? undefined,
			description: term.data ? JSON.parse(term.data).description : undefined,
			children: [],
			count: counts.get(term.translation_group ?? term.id) ?? 0,
			locale: term.locale,
			translationGroup: term.translation_group,
		});
	}

	for (const term of map.values()) {
		if (term.parentId && map.has(term.parentId)) {
			map.get(term.parentId)!.children.push(term);
		} else {
			roots.push(term);
		}
	}

	return roots;
}
