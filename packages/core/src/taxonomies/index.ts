/**
 * Runtime API for taxonomies
 *
 * Provides functions to query taxonomy definitions and terms.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { validateIdentifier } from "../database/validate.js";
import { getDb } from "../loader.js";
import { peekRequestCache, requestCached, setRequestCacheEntry } from "../request-cache.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { isMissingTableError } from "../utils/db-errors.js";
import type { TaxonomyDef, TaxonomyTerm, TaxonomyTermRow } from "./types.js";

/**
 * Worker-lifetime cache for the per-taxonomy term-counts map computed by
 * `countTermAssignmentsForTaxonomy`. Lives on `globalThis` so module
 * duplication during SSR bundling can't fragment the cache (same pattern
 * as `request-context.ts` and `secrets.ts`).
 *
 * Counts change when:
 *   - an entry's visibility flips (publish, unpublish, soft delete,
 *     restore, permanent delete)
 *   - a term assignment is added, removed, or replaced (e.g.
 *     `setTermsForEntry`, `attachToEntry`, `detachFromEntry`,
 *     `clearEntryTerms`)
 *   - a taxonomy term itself is created, renamed, or deleted
 *
 * Call `invalidateTermCache()` from any of those write paths to drop the
 * cache. Any new write path that affects either side of the join must
 * call it too.
 */
const TERM_COUNTS_CACHE_KEY = Symbol.for("@emdash-cms/core/term-counts-cache@1");

interface TermCountsHolder {
	cache: WeakMap<object, Map<string, Promise<Map<string, number>>>>;
}

function getTermCountsHolder(): TermCountsHolder {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern
	const holder = globalThis as Record<symbol, TermCountsHolder | undefined>;
	let entry = holder[TERM_COUNTS_CACHE_KEY];
	if (!entry) {
		entry = { cache: new WeakMap() };
		holder[TERM_COUNTS_CACHE_KEY] = entry;
	}
	return entry;
}

/**
 * Invalidate the worker-lifetime term-counts cache.
 *
 * Called from any write path that can change either side of the count
 * join — entry visibility (`content:publish`/`unpublish`, soft delete,
 * restore, permanent delete) and term assignment changes
 * (`setTermsForEntry`, `attachToEntry`, `detachFromEntry`,
 * `clearEntryTerms`, term create/update/delete). The next read
 * repopulates the cache lazily.
 */
export function invalidateTermCache(): void {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern
	const holder = globalThis as Record<symbol, TermCountsHolder | undefined>;
	if (holder[TERM_COUNTS_CACHE_KEY]) {
		holder[TERM_COUNTS_CACHE_KEY] = { cache: new WeakMap() };
	}
}

/**
 * Get all taxonomy definitions
 */
export async function getTaxonomyDefs(): Promise<TaxonomyDef[]> {
	return requestCached("taxonomy-defs:all", async () => {
		const db = await getDb();

		const rows = await db.selectFrom("_emdash_taxonomy_defs").selectAll().execute();

		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			label: row.label,
			labelSingular: row.label_singular ?? undefined,
			hierarchical: row.hierarchical === 1,
			collections: row.collections ? JSON.parse(row.collections) : [],
		}));
	});
}

/**
 * Get a single taxonomy definition by name
 *
 * If `getTaxonomyDefs()` has already loaded the full list in this request
 * (which happens during entry-term hydration on every page that renders a
 * collection), find the matching def in memory rather than running a
 * second `WHERE name=?` query against `_emdash_taxonomy_defs`.
 */
export async function getTaxonomyDef(name: string): Promise<TaxonomyDef | null> {
	const allDefs = peekRequestCache<TaxonomyDef[]>("taxonomy-defs:all");
	if (allDefs) {
		return (await allDefs).find((d) => d.name === name) ?? null;
	}

	return requestCached(`taxonomy-def:${name}`, async () => {
		const db = await getDb();

		const row = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("name", "=", name)
			.executeTakeFirst();

		if (!row) return null;

		return {
			id: row.id,
			name: row.name,
			label: row.label,
			labelSingular: row.label_singular ?? undefined,
			hierarchical: row.hierarchical === 1,
			collections: row.collections ? JSON.parse(row.collections) : [],
		};
	});
}

/**
 * Get all terms for a taxonomy (as tree for hierarchical, flat for tags)
 */
export async function getTaxonomyTerms(taxonomyName: string): Promise<TaxonomyTerm[]> {
	return requestCached(`taxonomy-terms:${taxonomyName}`, async () => {
		const db = await getDb();

		// Get taxonomy definition to check if hierarchical
		const def = await getTaxonomyDef(taxonomyName);
		if (!def) return [];

		// Get all terms for this taxonomy
		const rows = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("name", "=", taxonomyName)
			.orderBy("label", "asc")
			.execute();

		// Count entries for each term — only count published, non-deleted
		// entries. Without joining the content table, drafts and soft-
		// deleted rows inflated category/tag counts in widgets (#581).
		// Worker-lifetime cached: writes call `invalidateTermCache()`.
		const counts = await getCachedTermCounts(db, taxonomyName, def.collections);

		const flatTerms: TaxonomyTermRow[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			slug: row.slug,
			label: row.label,
			parent_id: row.parent_id,
			data: row.data,
		}));

		// If hierarchical, build tree. Otherwise return flat
		if (def.hierarchical) {
			return buildTree(flatTerms, counts);
		}

		return flatTerms.map((term) => ({
			id: term.id,
			name: term.name,
			slug: term.slug,
			label: term.label,
			children: [],
			count: counts.get(term.id) ?? 0,
		}));
	});
}

/**
 * Get a single term by taxonomy and slug
 */
export async function getTerm(taxonomyName: string, slug: string): Promise<TaxonomyTerm | null> {
	const db = await getDb();

	const row = await db
		.selectFrom("taxonomies")
		.selectAll()
		.where("name", "=", taxonomyName)
		.where("slug", "=", slug)
		.executeTakeFirst();

	if (!row) return null;

	// Get entry count — restricted to published, non-deleted entries (#581).
	// Deliberately reads the full per-taxonomy counts map from the same
	// worker-lifetime cache as `getTaxonomyTerms` rather than running a
	// narrower single-term query: a category/tag page typically renders
	// the widget that calls `getTaxonomyTerms` alongside `getTerm`, so
	// the shared cache turns the second call into a Map lookup with no
	// extra round-trip. A separate `WHERE taxonomy_id = ?` path would
	// either bypass the cache (extra query on every render) or fragment
	// it (separate cache keys for full vs. single-term reads).
	const def = await getTaxonomyDef(taxonomyName);
	const counts = def
		? await getCachedTermCounts(db, taxonomyName, def.collections)
		: new Map<string, number>();
	const count = counts.get(row.id) ?? 0;

	// Get children if hierarchical
	const childRows = await db
		.selectFrom("taxonomies")
		.selectAll()
		.where("parent_id", "=", row.id)
		.orderBy("label", "asc")
		.execute();

	const children = childRows.map((child) => ({
		id: child.id,
		name: child.name,
		slug: child.slug,
		label: child.label,
		parentId: child.parent_id ?? undefined,
		children: [],
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
	};
}

/**
 * Get terms assigned to an entry
 */
export function getEntryTerms(
	collection: string,
	entryId: string,
	taxonomyName?: string,
): Promise<TaxonomyTerm[]> {
	return requestCached(`terms:${collection}:${entryId}:${taxonomyName ?? "*"}`, async () => {
		const db = await getDb();

		let query = db
			.selectFrom("content_taxonomies")
			.innerJoin("taxonomies", "taxonomies.id", "content_taxonomies.taxonomy_id")
			.selectAll("taxonomies")
			.where("content_taxonomies.collection", "=", collection)
			.where("content_taxonomies.entry_id", "=", entryId);

		if (taxonomyName) {
			query = query.where("taxonomies.name", "=", taxonomyName);
		}

		const rows = await query.execute();

		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			slug: row.slug,
			label: row.label,
			parentId: row.parent_id ?? undefined,
			children: [],
		}));
	});
}

/**
 * Get terms for multiple entries in a single query (batched API)
 *
 * This is more efficient than calling getEntryTerms for each entry
 * when you need terms for a list of entries.
 *
 * @param collection - The collection type (e.g., "posts")
 * @param entryIds - Array of entry IDs
 * @param taxonomyName - The taxonomy name (e.g., "categories")
 * @returns Map from entry ID to array of terms
 */
export async function getTermsForEntries(
	collection: string,
	entryIds: string[],
	taxonomyName: string,
): Promise<Map<string, TaxonomyTerm[]>> {
	const result = new Map<string, TaxonomyTerm[]>();

	// Initialize all entry IDs with empty arrays so callers can always
	// expect the key to be present.
	const uniqueIds = [...new Set(entryIds)];
	for (const id of uniqueIds) {
		result.set(id, []);
	}

	if (uniqueIds.length === 0) {
		return result;
	}

	const db = await getDb();

	// Chunk the IN clause so we stay below D1's ~100 bound-parameter limit
	// (and equivalent limits on other dialects). Matches getContentBylinesMany.
	//
	// Sites with no term assignments get back empty rows for one query —
	// the previous "has any term assignments" probe spent a round-trip on
	// every request to save that single query on empty sites, which is
	// backwards. Pre-migration databases (content_taxonomies missing) fall
	// through to the `isMissingTableError` catch and return empties.
	for (const chunk of chunks(uniqueIds, SQL_BATCH_SIZE)) {
		let rows;
		try {
			rows = await db
				.selectFrom("content_taxonomies")
				.innerJoin("taxonomies", "taxonomies.id", "content_taxonomies.taxonomy_id")
				.select([
					"content_taxonomies.entry_id",
					"taxonomies.id",
					"taxonomies.name",
					"taxonomies.slug",
					"taxonomies.label",
					"taxonomies.parent_id",
				])
				.where("content_taxonomies.collection", "=", collection)
				.where("content_taxonomies.entry_id", "in", chunk)
				.where("taxonomies.name", "=", taxonomyName)
				.execute();
		} catch (error) {
			if (isMissingTableError(error)) return result;
			throw error;
		}

		for (const row of rows) {
			const entryId = row.entry_id;
			const term: TaxonomyTerm = {
				id: row.id,
				name: row.name,
				slug: row.slug,
				label: row.label,
				parentId: row.parent_id ?? undefined,
				children: [],
			};

			const terms = result.get(entryId);
			if (terms) {
				terms.push(term);
			}
		}
	}

	return result;
}

/**
 * Batch-fetch terms for multiple entries across ALL taxonomies in a single query.
 *
 * Returns a Map keyed by entry ID, where each value is a Record keyed by
 * taxonomy name with the matching terms as an array. Used by
 * getEmDashCollection to eagerly hydrate `entry.data.terms` and avoid
 * the N+1 pattern that callers hit when they loop and call getEntryTerms.
 *
 * Pre-migration databases (content_taxonomies missing) return an empty
 * Map — the join falls through to the `isMissingTableError` branch.
 */
export async function getAllTermsForEntries(
	collection: string,
	entryIds: string[],
): Promise<Map<string, Record<string, TaxonomyTerm[]>>> {
	const result = new Map<string, Record<string, TaxonomyTerm[]>>();

	// Initialize unique entry IDs with empty objects so callers can always
	// expect the key to be present. Deduping also reduces wasted bound
	// parameters when a caller accidentally passes duplicates.
	const uniqueIds = [...new Set(entryIds)];
	for (const id of uniqueIds) {
		result.set(id, {});
	}

	if (uniqueIds.length === 0) {
		return result;
	}

	const db = await getDb();

	// Look up which taxonomies apply to this collection. Used below to
	// seed empty arrays for taxonomies the entry has no terms in — so
	// callers (including the pre-populated getEntryTerms cache) get a
	// deterministic `[]` back rather than a cache miss that triggers a DB
	// round-trip just to confirm "no terms".
	const applicableTaxonomyNames = await getCollectionTaxonomyNames(collection);

	// Chunk the IN clause to stay below D1's ~100 bound-parameter limit
	// (and equivalent limits on other dialects). Matches getContentBylinesMany.
	//
	// Previously we did a separate "has any assignments" probe to skip the
	// join on empty sites. That traded one query per request for a query
	// saved only on empty sites — backwards. Now the join runs directly
	// (returning zero rows cheaply) and pre-migration databases are caught
	// by the `isMissingTableError` branch below.
	for (const chunk of chunks(uniqueIds, SQL_BATCH_SIZE)) {
		let rows;
		try {
			rows = await db
				.selectFrom("content_taxonomies")
				.innerJoin("taxonomies", "taxonomies.id", "content_taxonomies.taxonomy_id")
				.select([
					"content_taxonomies.entry_id",
					"taxonomies.id",
					"taxonomies.name",
					"taxonomies.slug",
					"taxonomies.label",
					"taxonomies.parent_id",
				])
				.where("content_taxonomies.collection", "=", collection)
				.where("content_taxonomies.entry_id", "in", chunk)
				.orderBy("taxonomies.label", "asc")
				.execute();
		} catch (error) {
			if (isMissingTableError(error)) {
				for (const id of uniqueIds) {
					primeEntryTermsCache(collection, id, {}, applicableTaxonomyNames);
				}
				return result;
			}
			throw error;
		}

		for (const row of rows) {
			const entryId = row.entry_id;
			const term: TaxonomyTerm = {
				id: row.id,
				name: row.name,
				slug: row.slug,
				label: row.label,
				parentId: row.parent_id ?? undefined,
				children: [],
			};

			const byTaxonomy = result.get(entryId);
			if (!byTaxonomy) continue;
			const existing = byTaxonomy[row.name];
			if (existing) {
				existing.push(term);
			} else {
				byTaxonomy[row.name] = [term];
			}
		}
	}

	// Prime the request-scoped cache so legacy callers of getEntryTerms
	// (which still work per-entry) hit the in-memory cache instead of
	// re-querying. This is what gives us the N+1 win in existing templates
	// without requiring them to be rewritten.
	for (const [entryId, byTaxonomy] of result) {
		primeEntryTermsCache(collection, entryId, byTaxonomy, applicableTaxonomyNames);
	}

	return result;
}

/**
 * Return the list of taxonomy names applicable to a collection, request-
 * cached so a page render only pays for it once.
 *
 * Returns an empty list when taxonomies haven't been defined yet.
 */
async function getCollectionTaxonomyNames(collection: string): Promise<string[]> {
	try {
		const defs = await getTaxonomyDefs();
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
): void {
	// Seed every applicable taxonomy with at least [] so
	// getEntryTerms(collection, id, "tag") doesn't miss the cache when an
	// entry has no tags.
	for (const name of applicableTaxonomyNames) {
		setRequestCacheEntry(`terms:${collection}:${entryId}:${name}`, byTaxonomy[name] ?? []);
	}
	// Also seed individual names that show up in data but aren't listed
	// as applicable (e.g. taxonomy reassigned to a different collection
	// since the terms were written).
	for (const [name, terms] of Object.entries(byTaxonomy)) {
		setRequestCacheEntry(`terms:${collection}:${entryId}:${name}`, terms);
	}
	// Flattened `*` view — all terms across all taxonomies in one array.
	const allTerms = Object.values(byTaxonomy).flat();
	setRequestCacheEntry(`terms:${collection}:${entryId}:*`, allTerms);
}

/**
 * Get entries by term (wraps getEmDashCollection)
 */
export async function getEntriesByTerm(
	collection: string,
	taxonomyName: string,
	termSlug: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
	const { getEmDashCollection } = await import("../query.js");

	// Build options as the expected type — getEmDashCollection accepts
	// a generic options object with `where` for filtering by taxonomy
	const options: Record<string, unknown> = {
		where: { [taxonomyName]: termSlug },
	};
	const { entries } = await getEmDashCollection(collection, options);

	return entries;
}

/**
 * Count `content_taxonomies` rows whose entry is currently published
 * and not soft-deleted, grouped by taxonomy_id, scoped to a single
 * taxonomy across every collection it applies to.
 *
 * The taxonomy → collection mapping comes from
 * `_emdash_taxonomy_defs.collections`; assignments to collections not
 * declared there are excluded (treated as drift). Each per-collection
 * subquery joins `taxonomies` and filters by `t.name = ${taxonomyName}`
 * so we don't aggregate counts for unrelated taxonomies that happen to
 * live in the same collection.
 *
 * Cold path: one `UNION ALL` round-trip combines per-collection joins
 * so a `tags` taxonomy spanning `posts` + `products` still costs one
 * query, not N. Pre-migration databases (or drift where a referenced
 * `ec_*` table is gone) fall back to a per-collection loop with
 * `isMissingTableError` recovery.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect-agnostic
async function countTermAssignmentsForTaxonomy(
	db: Kysely<any>,
	taxonomyName: string,
	collections: string[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();

	// Dedupe: `_emdash_taxonomy_defs.collections` is JSON, so a seed or
	// migration could yield duplicate entries. Without dedupe the
	// `UNION ALL` would count the same collection twice.
	const safeCollections = [...new Set(collections)].filter((collection) => {
		try {
			validateIdentifier(collection, "collection");
			return true;
		} catch {
			// Defense-in-depth: skip identifiers that wouldn't be safe to
			// interpolate even though `_emdash_collections` validates on insert.
			return false;
		}
	});

	if (safeCollections.length === 0) return counts;

	const buildPart = (collection: string) => sql`
		SELECT ct.taxonomy_id, COUNT(*) AS count
		FROM content_taxonomies ct
		INNER JOIN taxonomies t
			ON t.id = ct.taxonomy_id
		INNER JOIN ${sql.ref(`ec_${collection}`)} e
			ON e.id = ct.entry_id
		WHERE ct.collection = ${collection}
			AND t.name = ${taxonomyName}
			AND e.status = 'published'
			AND e.deleted_at IS NULL
		GROUP BY ct.taxonomy_id
	`;

	try {
		const unionParts = safeCollections.map(buildPart);
		const result = await sql<{ taxonomy_id: string; count: number | string }>`
			SELECT taxonomy_id, SUM(count) AS count
			FROM (${sql.join(unionParts, sql` UNION ALL `)}) AS sub
			GROUP BY taxonomy_id
		`.execute(db);
		for (const row of result.rows) {
			counts.set(row.taxonomy_id, Number(row.count));
		}
		return counts;
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
		// One or more `ec_{collection}` tables are missing (pre-migration
		// install or drift). Fall back to per-collection so we can skip the
		// missing ones without losing data from the rest.
	}

	for (const collection of safeCollections) {
		try {
			const result = await sql<{ taxonomy_id: string; count: number | string }>`
				${buildPart(collection)}
			`.execute(db);
			for (const row of result.rows) {
				const prev = counts.get(row.taxonomy_id) ?? 0;
				counts.set(row.taxonomy_id, prev + Number(row.count));
			}
		} catch (error) {
			if (isMissingTableError(error)) continue;
			throw error;
		}
	}
	return counts;
}

/**
 * Worker-lifetime cached wrapper around `countTermAssignmentsForTaxonomy`.
 *
 * Keyed by `(db, taxonomyName)` so playground / per-DO / per-test databases
 * each maintain their own counts. Caches the in-flight promise so concurrent
 * callers share one query; on error the cache entry is dropped so the next
 * caller retries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect-agnostic
function getCachedTermCounts(
	db: Kysely<any>,
	taxonomyName: string,
	collections: string[],
): Promise<Map<string, number>> {
	const { cache } = getTermCountsHolder();
	let perDb = cache.get(db);
	if (!perDb) {
		perDb = new Map();
		cache.set(db, perDb);
	}
	const cached = perDb.get(taxonomyName);
	if (cached) return cached;
	const promise = countTermAssignmentsForTaxonomy(db, taxonomyName, collections).catch((error) => {
		perDb.delete(taxonomyName);
		throw error;
	});
	perDb.set(taxonomyName, promise);
	return promise;
}

/**
 * Build tree structure from flat terms
 */
function buildTree(flatTerms: TaxonomyTermRow[], counts: Map<string, number>): TaxonomyTerm[] {
	const map = new Map<string, TaxonomyTerm>();
	const roots: TaxonomyTerm[] = [];

	// First pass: create nodes
	for (const term of flatTerms) {
		map.set(term.id, {
			id: term.id,
			name: term.name,
			slug: term.slug,
			label: term.label,
			parentId: term.parent_id ?? undefined,
			description: term.data ? JSON.parse(term.data).description : undefined,
			children: [],
			count: counts.get(term.id) ?? 0,
		});
	}

	// Second pass: build tree
	for (const term of map.values()) {
		if (term.parentId && map.has(term.parentId)) {
			map.get(term.parentId)!.children.push(term);
		} else {
			roots.push(term);
		}
	}

	return roots;
}
