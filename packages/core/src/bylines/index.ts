/**
 * Runtime API for bylines
 *
 * Provides functions to query byline profiles and byline credits
 * associated with content entries. Follows the same pattern as
 * the taxonomies runtime API.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { BylineRepository } from "../database/repositories/byline.js";
import type { BylineSummary, ContentBylineCredit } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getDb } from "../loader.js";
import { getRequestContext } from "../request-context.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { isMissingTableError } from "../utils/db-errors.js";

/**
 * Worker-lifetime cache of "does any byline exist in the database?".
 *
 * Stored on `globalThis` with a Symbol key so a single value is shared
 * even when the bundler duplicates this module across chunks — without
 * that, each chunk gets its own local variable and the probe re-runs on
 * every caller. (Same pattern as request-context.ts.) Module-scoped —
 * rather than keyed on the Kysely instance — because every anonymous
 * request in a D1 Sessions deployment gets a fresh session-bound Kysely,
 * and keying on the Kysely made the probe miss on every single request.
 *
 * Requests that route to an isolated DB (playground / DO preview) bypass
 * this cache — see `hasAnyBylines`.
 */
const HAS_BYLINES_KEY = Symbol.for("emdash:has-bylines-singleton");
interface HasBylinesHolder {
	value: boolean | null;
}
const bylinesHolder: HasBylinesHolder =
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern
	((globalThis as Record<symbol, unknown>)[HAS_BYLINES_KEY] as HasBylinesHolder | undefined) ??
	(() => {
		const h: HasBylinesHolder = { value: null };
		(globalThis as Record<symbol, unknown>)[HAS_BYLINES_KEY] = h;
		return h;
	})();

/**
 * Invalidate the cached "has any bylines" check.
 *
 * Call this when bylines are created, updated, or deleted.
 */
export function invalidateBylineCache(): void {
	bylinesHolder.value = null;
}

/**
 * Check if any bylines exist for the given DB instance. Result is cached
 * for the lifetime of the worker unless the request is routed to an
 * isolated DB, in which case the probe runs every time.
 *
 * Rethrows any error that is not a "missing table" error so callers see
 * real DB failures (permissions, connectivity, syntax) rather than silently
 * short-circuiting to "no bylines". Pre-migration databases return `false`
 * — the expected state before the table exists.
 */
async function hasAnyBylines(db: Kysely<Database>): Promise<boolean> {
	const isolated = getRequestContext()?.dbIsIsolated === true;
	if (!isolated && bylinesHolder.value !== null) {
		return bylinesHolder.value;
	}

	try {
		const result = await sql<{ id: string }>`
			SELECT id FROM _emdash_bylines LIMIT 1
		`.execute(db);
		const value = result.rows.length > 0;
		if (!isolated) bylinesHolder.value = value;
		return value;
	} catch (error) {
		if (isMissingTableError(error)) {
			if (!isolated) bylinesHolder.value = false;
			return false;
		}
		// Don't cache unknown failures; let the next call retry.
		throw error;
	}
}

/**
 * Get a byline by ID.
 *
 * @example
 * ```ts
 * import { getByline } from "emdash";
 *
 * const byline = await getByline("01HXYZ...");
 * if (byline) {
 *   console.log(byline.displayName);
 * }
 * ```
 */
export async function getByline(id: string): Promise<BylineSummary | null> {
	const db = await getDb();
	const repo = new BylineRepository(db);
	return repo.findById(id);
}

/**
 * Get a byline by slug.
 *
 * @example
 * ```ts
 * import { getBylineBySlug } from "emdash";
 *
 * const byline = await getBylineBySlug("jane-doe");
 * if (byline) {
 *   console.log(byline.displayName); // "Jane Doe"
 * }
 * ```
 */
export async function getBylineBySlug(slug: string): Promise<BylineSummary | null> {
	const db = await getDb();
	const repo = new BylineRepository(db);
	return repo.findBySlug(slug);
}

/**
 * Get byline credits for a single content entry.
 *
 * Returns explicit byline credits from the junction table. If none exist
 * but the entry has an `authorId`, falls back to the user-linked byline
 * (marked as source: "inferred").
 *
 * @example
 * ```ts
 * import { getEntryBylines } from "emdash";
 *
 * const bylines = await getEntryBylines("posts", post.data.id);
 * for (const credit of bylines) {
 *   console.log(credit.byline.displayName, credit.roleLabel);
 * }
 * ```
 */
export async function getEntryBylines(
	collection: string,
	entryId: string,
): Promise<ContentBylineCredit[]> {
	validateIdentifier(collection, "collection");
	const db = await getDb();
	const repo = new BylineRepository(db);

	const explicit = await repo.getContentBylines(collection, entryId);
	if (explicit.length > 0) {
		return explicit.map((c) => ({ ...c, source: "explicit" as const }));
	}

	// Fallback: look up user-linked byline from author_id
	const authorId = await getAuthorId(db, collection, entryId);
	if (authorId) {
		const fallback = await repo.findByUserId(authorId);
		if (fallback) {
			return [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }];
		}
	}

	return [];
}

/**
 * Batch-fetch byline credits for multiple content entries in a single query.
 *
 * This is more efficient than calling getEntryBylines for each entry
 * when you need bylines for a list of entries (e.g., a blog index page).
 *
 * @param collection - The collection slug (e.g., "posts")
 * @param entryIds - Array of entry IDs
 * @returns Map from entry ID to array of byline credits
 *
 * @example
 * ```ts
 * import { getBylinesForEntries, getEmDashCollection } from "emdash";
 *
 * const { entries } = await getEmDashCollection("posts");
 * const ids = entries.map(e => e.data.id);
 * const bylinesMap = await getBylinesForEntries("posts", ids);
 *
 * for (const entry of entries) {
 *   const bylines = bylinesMap.get(entry.data.id) ?? [];
 *   // render bylines
 * }
 * ```
 */
export async function getBylinesForEntries(
	collection: string,
	entryIds: string[],
): Promise<Map<string, ContentBylineCredit[]>> {
	validateIdentifier(collection, "collection");
	const result = new Map<string, ContentBylineCredit[]>();

	// Initialize all entry IDs with empty arrays
	for (const id of entryIds) {
		result.set(id, []);
	}

	if (entryIds.length === 0) {
		return result;
	}

	const db = await getDb();

	// Skip DB queries entirely when no bylines have been created.
	// The cache is invalidated when bylines are created/deleted.
	if (!(await hasAnyBylines(db))) {
		return result;
	}

	const repo = new BylineRepository(db);

	// 1. Batch fetch all explicit byline credits
	const bylinesMap = await repo.getContentBylinesMany(collection, entryIds);

	// 2. Collect entry IDs that need fallback lookup
	const fallbackEntryIds: string[] = [];
	const needsFallback: Map<string, string> = new Map(); // entryId -> authorId

	for (const id of entryIds) {
		if (!bylinesMap.has(id)) {
			// Need to check author_id for this entry — but we only have the IDs,
			// so batch-fetch them from the content table
			fallbackEntryIds.push(id);
		}
	}

	// Batch-fetch author_ids for entries that need fallback
	if (fallbackEntryIds.length > 0) {
		const authorMap = await getAuthorIds(db, collection, fallbackEntryIds);
		for (const [entryId, authorId] of authorMap) {
			needsFallback.set(entryId, authorId);
		}
	}

	// 3. Batch fetch user-linked bylines for fallback
	const uniqueAuthorIds = [...new Set(needsFallback.values())];
	const authorBylineMap = await repo.findByUserIds(uniqueAuthorIds);

	// 4. Assign results
	for (const id of entryIds) {
		const explicit = bylinesMap.get(id);
		if (explicit && explicit.length > 0) {
			result.set(
				id,
				explicit.map((c) => ({ ...c, source: "explicit" as const })),
			);
			continue;
		}

		const authorId = needsFallback.get(id);
		if (authorId) {
			const fallback = authorBylineMap.get(authorId);
			if (fallback) {
				result.set(id, [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }]);
				continue;
			}
		}

		// Already initialized with empty array
	}

	return result;
}

/**
 * Look up the author_id for a single content entry.
 * Uses raw SQL since we need dynamic table names.
 */
async function getAuthorId(
	db: Awaited<ReturnType<typeof getDb>>,
	collection: string,
	entryId: string,
): Promise<string | null> {
	validateIdentifier(collection, "collection");
	const tableName = `ec_${collection}`;

	const result = await sql<{ author_id: string | null }>`
		SELECT author_id FROM ${sql.ref(tableName)}
		WHERE id = ${entryId}
		LIMIT 1
	`.execute(db);

	return result.rows[0]?.author_id ?? null;
}

/**
 * Batch-fetch author_ids for multiple content entries.
 * Returns Map<entryId, authorId> (only entries with non-null author_id).
 */
async function getAuthorIds(
	db: Awaited<ReturnType<typeof getDb>>,
	collection: string,
	entryIds: string[],
): Promise<Map<string, string>> {
	validateIdentifier(collection, "collection");
	const tableName = `ec_${collection}`;

	const map = new Map<string, string>();
	for (const chunk of chunks(entryIds, SQL_BATCH_SIZE)) {
		const result = await sql<{ id: string; author_id: string | null }>`
			SELECT id, author_id FROM ${sql.ref(tableName)}
			WHERE id IN (${sql.join(chunk.map((id) => sql`${id}`))})
		`.execute(db);

		for (const row of result.rows) {
			if (row.author_id) {
				map.set(row.id, row.author_id);
			}
		}
	}
	return map;
}
