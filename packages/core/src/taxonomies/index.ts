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

import { TaxonomyRepository } from "../database/repositories/taxonomy.js";
import { resolveLocale, resolveLocaleChain } from "../i18n/resolve.js";
import { getDb, resetTaxonomyNamesCache } from "../loader.js";
import {
	cachedQuery,
	CacheNamespace,
	contentNamespace,
	invalidateTaxonomyObjectCache,
	isObjectCacheActive,
} from "../object-cache/index.js";
import { peekRequestCache, requestCached, setRequestCacheEntry } from "../request-cache.js";
import { getRequestContext } from "../request-context.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { isMissingTableError } from "../utils/db-errors.js";
import type { TaxonomyDef, TaxonomyTerm, TaxonomyTermRow } from "./types.js";

export interface TaxonomyQueryOptions {
	locale?: string;
	/**
	 * Roll usage counts up the hierarchy: each term's `count` becomes the
	 * number of distinct entries tagged anywhere in its subtree. Default is
	 * exact-term counts. Only meaningful for hierarchical taxonomies.
	 */
	rollup?: boolean;
}

/** Invalidate cached taxonomy term data and any content that hydrates terms. */
export function invalidateTermCache(): void {
	invalidateTaxonomyObjectCache();
}

/**
 * Worker-isolate cache for taxonomy definitions, keyed by resolved locale.
 *
 * Taxonomy *definitions* (the "category"/"tag" taxonomies themselves, not
 * their terms) are read on every public render that hydrates entry terms —
 * `getAllTermsForEntries` → `getCollectionTaxonomyNames` → `getTaxonomyDefs` —
 * but change extremely rarely: they're created via the admin API or applied
 * from a seed, and there is no edit/delete-def path. Caching them across the
 * isolate lifetime drops the per-render `SELECT * FROM _emdash_taxonomy_defs`
 * to once-per-isolate.
 *
 * Stored on globalThis behind a Symbol key (same pattern as
 * `settings/index.ts`) so the bundler duplicating this module across SSR
 * chunks can't produce two independent caches.
 *
 * When the distributed object cache is configured, it is authoritative and this
 * fallback is bypassed so cross-isolate epoch invalidation cannot be undercut
 * by stale per-isolate data on an object-cache miss.
 *
 * **Isolated databases bypass the cache.** Playground / DO preview requests
 * set `requestContext.dbIsIsolated`; they point at a divergent schema, so we
 * skip both reading and writing the global holder and fall back to the
 * per-request cache (same precedent as `getTaxonomyNames` / byline field defs).
 */
interface TaxonomyDefsHolder {
	version: number;
	/** locale key ("*" for "all locales") → { version it was fetched at, promise }. */
	cache: Map<string, { version: number; promise: Promise<TaxonomyDef[]> }>;
}

const TAXONOMY_DEFS_CACHE_KEY = Symbol.for("emdash:taxonomy-defs");
const taxonomyDefsStore = globalThis as Record<symbol, unknown>;
const defsHolder: TaxonomyDefsHolder =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see settings/index.ts)
	(taxonomyDefsStore[TAXONOMY_DEFS_CACHE_KEY] as TaxonomyDefsHolder | undefined) ??
	(() => {
		const h: TaxonomyDefsHolder = { version: 0, cache: new Map() };
		taxonomyDefsStore[TAXONOMY_DEFS_CACHE_KEY] = h;
		return h;
	})();

/**
 * Invalidate the isolate-wide taxonomy-definitions cache (and the related
 * loader taxonomy-names cache). Called from every taxonomy-def write path
 * (`handleTaxonomyCreate`, seed application). Other isolates refresh on their
 * next recycle — staleness bounded by isolate lifetime.
 */
export function invalidateTaxonomyDefsCache(): void {
	defsHolder.version++;
	defsHolder.cache.clear();
	resetTaxonomyNamesCache();
	invalidateTaxonomyObjectCache();
}

/**
 * Test/internal helper: clear the per-isolate taxonomy-defs cache. Useful for
 * unit tests that insert defs directly and need to force a refetch without
 * going through a write path. Production code should rely on
 * `invalidateTaxonomyDefsCache()`.
 */
export function resetTaxonomyDefsCacheForTests(): void {
	defsHolder.version++;
	defsHolder.cache.clear();
}

/**
 * Fetch taxonomy definitions straight from the database (no caching).
 */
async function fetchTaxonomyDefs(locale: string | undefined): Promise<TaxonomyDef[]> {
	const db = await getDb();
	let query = db.selectFrom("_emdash_taxonomy_defs").selectAll();
	if (locale !== undefined) query = query.where("locale", "=", locale);
	const rows = await query.execute();
	return rows.map(rowToTaxonomyDef);
}

/**
 * Resolve taxonomy defs through the isolate fallback cache, bypassing it for
 * isolated databases. The returned promise is cached (not the resolved value)
 * so concurrent cold-isolate readers share one in-flight query; a rejection
 * evicts the entry so the next caller retries.
 */
function loadTaxonomyDefs(localeKey: string, locale: string | undefined): Promise<TaxonomyDef[]> {
	if (getRequestContext()?.dbIsIsolated === true) {
		return fetchTaxonomyDefs(locale);
	}
	const existing = defsHolder.cache.get(localeKey);
	if (existing && existing.version === defsHolder.version) {
		return existing.promise;
	}
	const version = defsHolder.version;
	const promise = fetchTaxonomyDefs(locale).catch((error: unknown) => {
		const current = defsHolder.cache.get(localeKey);
		if (current && current.promise === promise) {
			defsHolder.cache.delete(localeKey);
		}
		throw error;
	});
	defsHolder.cache.set(localeKey, { version, promise });
	return promise;
}

/**
 * Get every taxonomy definition. Definitions are per-locale (one row per
 * locale inside the same translation_group) — by default we resolve to the
 * active locale.
 *
 * Two-tier cache: per-request via `requestCached` (so a single render that
 * hydrates terms for several collections pays at most one call), then
 * per-isolate via the global holder (so warm renders issue zero queries).
 * The `requestCached` key is unchanged so `getTaxonomyDef`'s peek still hits.
 */
export async function getTaxonomyDefs(options: TaxonomyQueryOptions = {}): Promise<TaxonomyDef[]> {
	const locale = resolveLocale(options.locale);
	const localeKey = locale ?? "*";
	return requestCached(`taxonomy-defs:${localeKey}`, async () => {
		if (await isObjectCacheActive()) {
			return cachedQuery({
				namespace: CacheNamespace.TAXONOMIES,
				key: `defs:${localeKey}`,
				load: () => fetchTaxonomyDefs(locale),
			});
		}
		return loadTaxonomyDefs(localeKey, locale);
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
	const rollup = options.rollup ? "1" : "0";
	return requestCached(`taxonomy-terms:${taxonomyName}:${locale ?? "*"}:r${rollup}`, () =>
		cachedQuery({
			namespace: CacheNamespace.TAXONOMIES,
			key: `terms:${taxonomyName}:${locale ?? "*"}:r${rollup}`,
			load: () => loadTaxonomyTerms(taxonomyName, locale, options),
		}),
	);
}

async function loadTaxonomyTerms(
	taxonomyName: string,
	locale: string | undefined,
	options: TaxonomyQueryOptions,
): Promise<TaxonomyTerm[]> {
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

	// Counts are keyed by translation_group (what the pivot stores) and are
	// locale-independent, so the aggregate is shared across every taxonomy
	// rendered in this request (Categories + Tags widgets, etc.).
	const counts = options.rollup
		? await getTaxonomySubtreeCounts(taxonomyName)
		: await getTaxonomyTermCounts();

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
		description: term.data ? JSON.parse(term.data).description : undefined,
		children: [],
		count: counts.get(term.translation_group ?? term.id) ?? 0,
		locale: term.locale,
		translationGroup: term.translation_group,
	}));
}

/**
 * Subtree (rolled-up, distinct-entry) usage counts for one taxonomy, keyed by
 * translation_group. Request-cached per taxonomy. Unlike the flat
 * `getTaxonomyTermCounts` aggregate (shared across all taxonomies), the rollup
 * is hierarchy-specific so it is keyed by name.
 */
function getTaxonomySubtreeCounts(taxonomyName: string): Promise<Map<string, number>> {
	return requestCached(`taxonomy-subtree-counts:${taxonomyName}`, async () => {
		const db = await getDb();
		return new TaxonomyRepository(db).countEntriesForSubtrees(taxonomyName);
	});
}

/**
 * Per-translation-group usage counts across all taxonomies, in one aggregate
 * scan of `content_taxonomies`. Counts are locale-independent (the pivot stores
 * translation_group), so a single request-cached entry serves every taxonomy
 * that renders during the request.
 */
function getTaxonomyTermCounts(): Promise<Map<string, number>> {
	return requestCached("taxonomy-term-counts", async () => {
		const db = await getDb();
		const countsResult = await db
			.selectFrom("content_taxonomies")
			.select(["taxonomy_id"])
			.select((eb) => eb.fn.count<number>("entry_id").as("count"))
			.groupBy("taxonomy_id")
			.execute();
		const counts = new Map<string, number>();
		// Postgres `COUNT()` returns bigint as a string; coerce so callers always
		// get a number (matches `countEntriesForSubtrees`).
		for (const row of countsResult) counts.set(row.taxonomy_id, Number(row.count ?? 0));
		return counts;
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
	const chain = resolveLocaleChain(options.locale);
	// Cached under the shared taxonomies epoch (bumped on any taxonomy / term
	// assignment write). The `count` reflects content_taxonomies rows; a stale
	// count after a bare content delete is bounded by the entry's TTL.
	return cachedQuery({
		namespace: CacheNamespace.TAXONOMIES,
		key: `term:${taxonomyName}:${slug}:${chain.join(",")}`,
		load: () => loadTerm(taxonomyName, slug, chain),
	});
}

async function loadTerm(
	taxonomyName: string,
	slug: string,
	chain: string[],
): Promise<TaxonomyTerm | null> {
	const db = await getDb();

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

	let childrenQuery = db
		.selectFrom("taxonomies")
		.selectAll()
		// Children store the parent's translation_group in parent_id (not a row
		// id), so a translated parent still owns its children in its own locale.
		.where("parent_id", "=", row.translation_group ?? row.id)
		.orderBy("label", "asc");
	const termLocale = row.locale;
	if (termLocale) childrenQuery = childrenQuery.where("locale", "=", termLocale);

	// The usage-count and children queries both depend only on the term row,
	// so run them concurrently to save a round trip on remote databases.
	const [countResult, childRows] = await Promise.all([
		db
			.selectFrom("content_taxonomies")
			.select((eb) => eb.fn.count<number>("entry_id").as("count"))
			.where("taxonomy_id", "=", row.translation_group ?? row.id)
			.executeTakeFirst(),
		childrenQuery.execute(),
	]);
	const count = countResult?.count ?? 0;

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
	// requestCached short-circuits to values primed by getAllTermsForEntries
	// during entry hydration (same key shape). On a warm content-cache hit
	// hydration doesn't run, so the inner cachedQuery serves this from KV
	// instead of falling through to D1 on every request.
	return requestCached(
		`terms:${collection}:${entryId}:${taxonomyName ?? "*"}:${locale ?? "*"}`,
		() =>
			cachedQuery({
				namespace: [contentNamespace(collection), CacheNamespace.TAXONOMIES],
				key: `entryTerms:${collection}:${entryId}:${taxonomyName ?? "*"}:${locale ?? "*"}`,
				load: async () => {
					const db = await getDb();

					let query = db
						.selectFrom("content_taxonomies")
						.innerJoin(
							"taxonomies",
							"taxonomies.translation_group",
							"content_taxonomies.taxonomy_id",
						)
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
			}),
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
	const uniqueIds = [...new Set(entryIds)];
	if (uniqueIds.length === 0) return new Map();
	const locale = resolveLocale(options.locale);
	const localeKey = locale ?? "*";

	// The query result is a Map, which JSON can't represent — cache it as an
	// array of [entryId, terms] pairs and rebuild the Map on read.
	const load = async (): Promise<Array<[string, TaxonomyTerm[]]>> => {
		const result = new Map<string, TaxonomyTerm[]>();
		for (const id of uniqueIds) result.set(id, []);

		// Entry-term hydration (getAllTermsForEntries -> primeEntryTermsCache)
		// seeds the per-entry cache under the same key getEntryTerms uses:
		// `terms:${collection}:${entryId}:${taxonomyName}:${localeKey}`, storing a
		// TaxonomyTerm[] (including `[]` for entries with no terms). Satisfy those
		// from cache and run the batched query only for the ids that missed.
		const missedIds: string[] = [];
		type CacheRead = { id: string; terms: TaxonomyTerm[] } | { id: string; miss: true };
		const cacheReads: Array<Promise<CacheRead>> = [];
		for (const id of uniqueIds) {
			const cached = peekRequestCache<TaxonomyTerm[]>(
				`terms:${collection}:${id}:${taxonomyName}:${localeKey}`,
			);
			if (cached) {
				// A peeked promise can reject (e.g. a sibling getEntryTerms hit a
				// missing table). Treat a rejection as a cache miss so the batched
				// query path -- and its isMissingTableError guard below -- still runs,
				// rather than propagating an uncaught error.
				cacheReads.push(
					cached.then(
						(terms): CacheRead => ({ id, terms }),
						(): CacheRead => ({ id, miss: true }),
					),
				);
			} else {
				missedIds.push(id);
			}
		}
		for (const read of await Promise.all(cacheReads)) {
			if ("miss" in read) {
				missedIds.push(read.id);
				continue;
			}
			// Return a private copy. The cached array and its term objects are shared
			// with getEntryTerms/getAllTermsForEntries (primeEntryTermsCache stores
			// the same references), so a caller that mutates the result -- sorting in
			// place, pushing into `children` -- must not poison the cache. The
			// pre-cache implementation always returned freshly built arrays.
			result.set(
				read.id,
				read.terms.map((t) => ({ ...t, children: [...t.children] })),
			);
		}

		if (missedIds.length === 0) return [...result.entries()];

		const db = await getDb();
		for (const chunk of chunks(missedIds, SQL_BATCH_SIZE)) {
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
					.where("taxonomies.name", "=", taxonomyName)
					// Match the order getAllTermsForEntries (the cache primer) uses, so
					// cache-hit and DB-miss entries in one result are ordered consistently.
					.orderBy("taxonomies.label", "asc");
				if (locale !== undefined) query = query.where("taxonomies.locale", "=", locale);
				rows = await query.execute();
			} catch (error) {
				if (isMissingTableError(error)) return [...result.entries()];
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

		return [...result.entries()];
	};

	// Key on the sorted unique ids. Bound the key length: very large batches
	// (rare; they come from collection hydration, already served by the content
	// cache) bypass the object cache rather than blow past KV's key limit.
	const idKey = uniqueIds.toSorted().join(",");
	const pairs =
		idKey.length <= 256
			? await cachedQuery({
					namespace: [contentNamespace(collection), CacheNamespace.TAXONOMIES],
					key: `termsForEntries:${collection}:${taxonomyName}:${locale ?? "*"}:${idKey}`,
					load,
				})
			: await load();

	return new Map(pairs);
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
 * Prime the per-entry request cache from terms that were folded into the
 * content query (query.ts `hydrateEntryTerms` fast path), so subsequent
 * `getEntryTerms` calls in the same render hit the cache instead of issuing an
 * N+1 query. Seeds the wildcard key and one key per taxonomy present on the
 * entry — purely from the folded data, with no DB lookup.
 *
 * Unlike `getAllTermsForEntries`, this deliberately does NOT seed `[]` for
 * taxonomies that apply to the collection but have no rows on the entry: doing
 * so would require a `getTaxonomyDefs` query, adding a round trip to every fold
 * render to serve the rarer `getEntryTerms(id, absentTaxonomy)` case from cache.
 * That call simply falls through to its own cached query. Keeping the key shape
 * here (rather than in query.ts) prevents the two from drifting.
 */
export function primeFoldedEntryTerms(
	collection: string,
	perEntry: Array<{ entryId: string; byTaxonomy: Record<string, TaxonomyTerm[]> }>,
	options: TaxonomyQueryOptions = {},
): void {
	if (perEntry.length === 0) return;
	const locale = resolveLocale(options.locale);
	for (const { entryId, byTaxonomy } of perEntry) {
		primeEntryTermsCache(collection, entryId, byTaxonomy, [], locale);
	}
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
	// parent_id holds the parent's translation_group, so link children by it.
	// Key by (locale, group): a child's parent lives in the same locale, and an
	// unfiltered set mixes locales whose translated siblings share a group —
	// keying by group alone would collide and misattach children across locales.
	const byLocaleGroup = new Map<string, TaxonomyTerm>();
	const nodes: TaxonomyTerm[] = [];
	const roots: TaxonomyTerm[] = [];

	for (const term of flatTerms) {
		const node: TaxonomyTerm = {
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
		};
		byLocaleGroup.set(`${term.locale}::${term.translation_group ?? term.id}`, node);
		nodes.push(node);
	}

	for (const node of nodes) {
		const parent = node.parentId
			? byLocaleGroup.get(`${node.locale}::${node.parentId}`)
			: undefined;
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}

	return roots;
}
