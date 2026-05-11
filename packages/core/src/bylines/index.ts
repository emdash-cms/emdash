/**
 * Runtime API for bylines
 *
 * Provides functions to query byline profiles and byline credits
 * associated with content entries. Follows the same pattern as
 * the taxonomies runtime API.
 */

import { sql } from "kysely";

import { BylineRepository } from "../database/repositories/byline.js";
import type { BylineSummary, ContentBylineCredit } from "../database/repositories/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getDb } from "../loader.js";
import { isMissingTableError } from "../utils/db-errors.js";

/**
 * No-op — kept for API compatibility.
 *
 * Used to invalidate a worker-lifetime "has any byline?" probe. That
 * probe added a query on every cold isolate to save one query on sites
 * with zero bylines (i.e. the wrong tradeoff), so we dropped it. The
 * batch byline join below returns an empty map for empty sites at the
 * same cost as the probe, without the pre-check.
 */
export function invalidateBylineCache(): void {
	// Intentionally empty.
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
 * Internal: not re-exported from the `emdash` package entry point. Every
 * entry returned by `getEmDashCollection` / `getEmDashEntry` already has
 * `data.bylines` populated by `hydrateEntryBylines` (which uses the batch
 * helper `getBylinesForEntries` directly). Site code should read those
 * fields rather than calling this function.
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
 * An entry reference for batch byline lookups.
 *
 * `authorId` is read directly from the row when computing the inferred-byline
 * fallback — passing it in avoids a redundant `SELECT id, author_id` against
 * the content table after every list/entry fetch.
 */
export interface BylineEntry {
	id: string;
	authorId: string | null;
}

/**
 * Batch-fetch byline credits for multiple content entries in a single query.
 *
 * Internal: consumed by `hydrateEntryBylines` in `query.ts` so that every
 * entry returned from `getEmDashCollection` / `getEmDashEntry` already has
 * `data.bylines` populated. Site code should rely on that eager hydration
 * rather than calling this directly -- this function is not re-exported
 * from the `emdash` package entry point.
 *
 * @param collection - The collection slug (e.g., "posts")
 * @param entries - Entry id + authorId pairs (authorId is already on the row)
 * @returns Map from entry ID to array of byline credits
 */
export async function getBylinesForEntries(
	collection: string,
	entries: BylineEntry[],
): Promise<Map<string, ContentBylineCredit[]>> {
	validateIdentifier(collection, "collection");
	const result = new Map<string, ContentBylineCredit[]>();

	for (const { id } of entries) {
		result.set(id, []);
	}

	if (entries.length === 0) {
		return result;
	}

	const db = await getDb();
	const repo = new BylineRepository(db);
	const entryIds = entries.map((e) => e.id);

	// Sites with no bylines get an empty map back for one query — the previous
	// "has any bylines" probe traded an extra round-trip on every request to
	// save that one query on empty sites, which is exactly backwards for the
	// common case. Pre-migration databases (bylines table missing) fall
	// through to the `isMissingTableError` catch below and return empty.
	let bylinesMap;
	try {
		bylinesMap = await repo.getContentBylinesMany(collection, entryIds);
	} catch (error) {
		if (isMissingTableError(error)) return result;
		throw error;
	}

	const needsFallback = new Map<string, string>();
	for (const { id, authorId } of entries) {
		if (!bylinesMap.has(id) && authorId) {
			needsFallback.set(id, authorId);
		}
	}

	const uniqueAuthorIds = [...new Set(needsFallback.values())];
	const authorBylineMap = await repo.findByUserIds(uniqueAuthorIds);

	for (const { id } of entries) {
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
			}
		}
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
