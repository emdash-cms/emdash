/**
 * Per-isolate cache of registered collection slugs (`_emdash_collections`).
 *
 * Term counting scopes its per-collection UNION to a taxonomy's declared
 * collections, but a declared collection is not necessarily a created one:
 * the migration-seeded defaults declare `posts` whether or not that
 * collection ever exists. Querying optimistically and catching the
 * missing-table error keeps results correct, yet the failed statement itself
 * is logged by the database — on D1 it surfaces as a `no such table` error
 * span per taxonomy per uncached render. Filtering declared collections
 * against the registry up front means the failing statement is never sent.
 *
 * Stored on globalThis behind a Symbol key (same pattern as the taxonomy-defs
 * cache in `taxonomies/index.ts`) so bundler chunk duplication cannot produce
 * two independent caches. The promise is cached, so concurrent cold readers
 * share one in-flight query; a rejection evicts the entry.
 *
 * Freshness:
 * - Primed for free at isolate boot: runtime init's auto-seed gate already
 *   reads `_emdash_collections` and hands the slugs to
 *   `primeRegisteredCollections`, so cold isolates pay no extra query.
 * - Every schema-mutation path resets it: `invalidateUrlPatternCache()`
 *   (admin API, MCP, WordPress import, seed application) and
 *   `SchemaRegistry.createCollection`/`deleteCollection` for direct callers.
 * - Creations on *other* isolates surface through bounded revalidation: the
 *   set is re-fetched only when the filter would actually drop a declared
 *   collection and the cached copy is older than the revalidation window.
 *   Sites whose declared collections all exist — the steady state — never
 *   revalidate; a site with a genuinely absent collection pays one slug read
 *   per window instead of one failing statement per render, and a collection
 *   created elsewhere starts counting within the window.
 *
 * Isolated databases bypass the cache (playground / DO preview requests set
 * `requestContext.dbIsIsolated`): they point at a divergent schema, so the
 * slug set is fetched per request instead, deduped by the request cache.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { requestCached } from "../request-cache.js";
import { getRequestContext } from "../request-context.js";

interface SlugsHolder {
	promise: Promise<Set<string>> | null;
	/** When the cached promise was created; gates bounded revalidation. */
	fetchedAt: number;
}

const HOLDER_KEY = Symbol.for("emdash:collection-slugs");
const g = globalThis as Record<symbol, unknown>;
const holder: SlugsHolder =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-cache.ts)
	(g[HOLDER_KEY] as SlugsHolder | undefined) ??
	(() => {
		const h: SlugsHolder = { promise: null, fetchedAt: 0 };
		g[HOLDER_KEY] = h;
		return h;
	})();

const REVALIDATE_WINDOW_MS = 60_000;
let revalidateWindowMs = REVALIDATE_WINDOW_MS;

async function fetchSlugs(db: Kysely<Database>): Promise<Set<string>> {
	const rows = await db.selectFrom("_emdash_collections").select("slug").execute();
	return new Set(rows.map((row) => row.slug));
}

function loadSlugs(db: Kysely<Database>): Promise<Set<string>> {
	if (holder.promise) return holder.promise;
	const promise = fetchSlugs(db).catch((error: unknown) => {
		if (holder.promise === promise) holder.promise = null;
		throw error;
	});
	holder.promise = promise;
	holder.fetchedAt = Date.now();
	return promise;
}

/**
 * Keep only the collections that have a `_emdash_collections` row, i.e. whose
 * `ec_*` table the registry has created. When the filter would drop a
 * collection and the cached set is older than the revalidation window, the
 * set is re-fetched once so a collection created by another isolate becomes
 * visible without waiting for an isolate recycle.
 */
export async function filterToRegisteredCollections(
	db: Kysely<Database>,
	collections: readonly string[],
): Promise<string[]> {
	if (collections.length === 0) return [];
	if (getRequestContext()?.dbIsIsolated === true) {
		const slugs = await requestCached("collection-slugs", () => fetchSlugs(db));
		return collections.filter((slug) => slugs.has(slug));
	}
	let slugs = await loadSlugs(db);
	let present = collections.filter((slug) => slugs.has(slug));
	if (present.length < collections.length && Date.now() - holder.fetchedAt > revalidateWindowMs) {
		holder.promise = null;
		slugs = await loadSlugs(db);
		present = collections.filter((slug) => slugs.has(slug));
	}
	return present;
}

/**
 * Seed the cache with slugs an init-time read already fetched, so the first
 * render on a cold isolate pays no extra query. Called by the runtime's
 * auto-seed gate.
 */
export function primeRegisteredCollections(slugs: readonly string[]): void {
	holder.promise = Promise.resolve(new Set(slugs));
	holder.fetchedAt = Date.now();
}

/**
 * Drop the cached slug set so the next reader re-fetches. Called from every
 * schema-mutation path (`invalidateUrlPatternCache`, `SchemaRegistry`
 * create/delete). Other isolates converge through bounded revalidation.
 */
export function resetRegisteredCollectionsCache(): void {
	holder.promise = null;
	holder.fetchedAt = 0;
}

/**
 * Note that a query hit a missing `ec_*` table despite the slug filter: the
 * cached set is stale (the collection was deleted on another isolate) or the
 * registry has drifted from the physical schema. Drops the cached set at most
 * once per revalidation window, so the delete case converges like the create
 * case while genuine drift costs one slug re-fetch per window instead of one
 * per render.
 */
export function noteStaleRegisteredCollections(): void {
	if (Date.now() - holder.fetchedAt > revalidateWindowMs) {
		resetRegisteredCollectionsCache();
	}
}

/**
 * Test/internal helper: reset the cache and restore the production
 * revalidation window.
 */
export function resetRegisteredCollectionsCacheForTests(): void {
	resetRegisteredCollectionsCache();
	revalidateWindowMs = REVALIDATE_WINDOW_MS;
}

/**
 * Test-only: shorten the revalidation window so the cross-isolate refresh
 * path can be exercised without waiting out the production window.
 *
 * @internal
 */
export function setRegisteredCollectionsRevalidateWindowForTests(ms: number): void {
	revalidateWindowMs = ms;
}
