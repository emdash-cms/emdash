/**
 * Shared visible-usage counts for taxonomy terms (issue #581).
 *
 * `content_taxonomies` rows are written for every entry regardless of status
 * and are never pruned on unpublish/trash, so counting the pivot directly
 * inflates counts with drafts and soft-deleted entries. Every user-facing
 * count (public widget, single-term page, admin term list) must instead count
 * only entries that are currently visible on the public site:
 * `status = 'published'` OR (`status = 'scheduled'` AND due), AND
 * `deleted_at IS NULL` — via `buildStatusCondition`, which computes scheduled
 * visibility at query time rather than trusting a literal status value.
 *
 * The public render path is latency-sensitive on D1, so per-collection counts
 * are combined into a single round-trip with UNION ALL — one query per
 * taxonomy, never one per collection.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { buildStatusCondition } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { isMissingTableError } from "../utils/db-errors.js";

interface CountRow {
	taxonomy_id: string;
	count: number | string | bigint;
}

/**
 * Per-collection count branch. `taxonomy_id` stores the term's
 * translation_group, so results are keyed by group (locale-independent) and
 * each assignment is counted once no matter how many locales the term has.
 *
 * Scoping to the taxonomy uses `translation_group IN (...)` rather than a
 * join on `taxonomies.id` — the anchor row (id == group) can be deleted while
 * sibling translations survive, and a plain join on `translation_group` would
 * multiply counts by the number of locales.
 */
function collectionBranch(
	db: Kysely<Database>,
	taxonomyName: string,
	collection: string,
): ReturnType<typeof sql> {
	return sql`
		SELECT ct.taxonomy_id AS taxonomy_id, COUNT(*) AS count
		FROM content_taxonomies AS ct
		INNER JOIN ${sql.ref(`ec_${collection}`)} AS e ON e.id = ct.entry_id
		WHERE ct.collection = ${collection}
			AND ct.taxonomy_id IN (SELECT translation_group FROM taxonomies WHERE name = ${taxonomyName})
			AND ${buildStatusCondition(db, "published", "e")}
			AND e.deleted_at IS NULL
		GROUP BY ct.taxonomy_id`;
}

async function runCounts(
	db: Kysely<Database>,
	taxonomyName: string,
	collections: string[],
): Promise<Map<string, number>> {
	const branches = collections.map((collection) => collectionBranch(db, taxonomyName, collection));
	const union = sql.join(branches, sql` UNION ALL `);
	const result = await sql<CountRow>`
		SELECT taxonomy_id, SUM(count) AS count
		FROM (${union}) AS per_collection
		GROUP BY taxonomy_id`.execute(db);

	const counts = new Map<string, number>();
	for (const row of result.rows) counts.set(row.taxonomy_id, Number(row.count));
	return counts;
}

/**
 * Count publicly-visible term assignments for one taxonomy, keyed by the
 * term's translation_group (what `content_taxonomies.taxonomy_id` stores).
 *
 * Counts are scoped to the taxonomy's declared collections — pass
 * `TaxonomyDef.collections` (`_emdash_taxonomy_defs.collections`). Collections
 * whose `ec_*` table doesn't exist (pre-migration drift, a declared collection
 * that was never created) are skipped, yielding a partial-but-correct count
 * rather than a throw.
 *
 * One database round-trip for the whole taxonomy (UNION ALL across
 * collections). Callers on the public render path should go through the
 * request-cached wrapper in `taxonomies/index.ts` so a page rendering both the
 * widget and a term detail shares one computation.
 */
export async function fetchVisibleTermCounts(
	db: Kysely<Database>,
	taxonomyName: string,
	collections: string[],
): Promise<Map<string, number>> {
	const unique = [...new Set(collections)];
	for (const collection of unique) validateIdentifier(collection, "collection slug");
	if (unique.length === 0) return new Map();

	try {
		return await runCounts(db, taxonomyName, unique);
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
	}

	// A declared collection has no ec_* table — retry per collection so the
	// existing tables still contribute (still scheduled-aware + deleted_at).
	const counts = new Map<string, number>();
	for (const collection of unique) {
		try {
			for (const [group, count] of await runCounts(db, taxonomyName, [collection])) {
				counts.set(group, (counts.get(group) ?? 0) + count);
			}
		} catch (error) {
			if (!isMissingTableError(error)) throw error;
		}
	}
	return counts;
}
