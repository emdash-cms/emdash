/**
 * Per-isolate cache of the existing `ec_*` content-table names.
 *
 * Term counting (`taxonomies/term-counts.ts`) needs to know which of a
 * taxonomy's declared collections actually have a content table before it can
 * count: migration 006 seeds the default `category`/`tag` defs bound to a
 * `posts` collection that only exists if a seed creates it, and defs can also
 * drift when a collection is deleted. Content tables change only through
 * `SchemaRegistry.createCollection`/`deleteCollection`, so the lookup is
 * cached for the isolate lifetime and reset by those write paths — the same
 * pattern as the loader's taxonomy-names cache. Other isolates converge on
 * recycle; readers that still hit a dropped table refresh explicitly via
 * `resetContentTableNamesCache()`.
 *
 * Stored on globalThis behind a Symbol key (same pattern as
 * `taxonomies/index.ts`) so a bundler duplicating this module across SSR
 * chunks can't produce two independent caches.
 *
 * **Isolated databases bypass the cache.** Playground / DO preview requests
 * set `requestContext.dbIsIsolated`; they point at a divergent schema, so we
 * skip both reading and writing the holder (same precedent as the loader's
 * `getTaxonomyNames`).
 */

import type { Kysely } from "kysely";

import { getRequestContext } from "../request-context.js";
import { listTablesLike } from "./dialect-helpers.js";
import type { Database } from "./types.js";

interface ContentTablesHolder {
	promise: Promise<Set<string>> | null;
}

const CACHE_KEY = Symbol.for("emdash:content-tables");
const contentTablesStore = globalThis as Record<symbol, unknown>;
const holder: ContentTablesHolder =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see taxonomies/index.ts)
	(contentTablesStore[CACHE_KEY] as ContentTablesHolder | undefined) ??
	(() => {
		const h: ContentTablesHolder = { promise: null };
		contentTablesStore[CACHE_KEY] = h;
		return h;
	})();

async function fetchContentTableNames(db: Kysely<Database>): Promise<Set<string>> {
	return new Set(await listTablesLike(db, "ec_%"));
}

/**
 * Names of the `ec_*` tables that exist in the database. The promise is
 * cached (not the resolved value) so concurrent cold-isolate readers share
 * one in-flight query; a rejection evicts the entry so the next caller
 * retries.
 */
export function getContentTableNames(db: Kysely<Database>): Promise<Set<string>> {
	if (getRequestContext()?.dbIsIsolated === true) {
		return fetchContentTableNames(db);
	}
	if (holder.promise) return holder.promise;
	const promise = fetchContentTableNames(db).catch((error: unknown) => {
		if (holder.promise === promise) holder.promise = null;
		throw error;
	});
	holder.promise = promise;
	return promise;
}

/**
 * Reset the per-isolate content-table-names cache. Called from every path
 * that creates or drops an `ec_*` table (`SchemaRegistry`) and by readers
 * that observe a missing table despite the cached list (stale isolate).
 */
export function resetContentTableNamesCache(): void {
	holder.promise = null;
}
