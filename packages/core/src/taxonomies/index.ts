/**
 * Runtime API for taxonomies
 *
 * Provides functions to query taxonomy definitions and terms.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { requestCached } from "../request-cache.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { isMissingTableError } from "../utils/db-errors.js";
import type { TaxonomyDef, TaxonomyTerm, TaxonomyTermRow } from "./types.js";

/**
 * Per-DB cache of "does any taxonomy term assignment exist?".
 *
 * Keyed by the resolved Kysely instance rather than held at module scope so
 * per-request DB overrides (preview sessions, D1 Sessions API replicas,
 * Durable Object playground mode) don't bleed cached results across
 * unrelated database instances. WeakMap lets garbage-collected per-request
 * Kysely instances release their entry automatically.
 *
 * Missing key = unchecked, `true`/`false` = cached probe result.
 */
let hasTermAssignmentsCache: WeakMap<Kysely<Database>, boolean> = new WeakMap();

/**
 * Invalidate the cached "has any term assignments" check across all databases.
 *
 * Called by admin routes after creating/deleting term assignments, updating
 * terms, or deleting taxonomies. Writes are rare compared to reads, so we
 * clear the whole map rather than tracking which DB was mutated — instances
 * that are no longer referenced will be collected anyway.
 */
export function invalidateTermCache(): void {
	hasTermAssignmentsCache = new WeakMap();
}

/**
 * Check whether any row exists in content_taxonomies for the given DB.
 * Result is cached per-DB for the lifetime of that DB handle.
 *
 * Rethrows any error that is not a "missing table" error so callers see
 * real DB failures (permissions, connectivity, syntax) rather than
 * silently short-circuiting to "no terms". Pre-migration databases return
 * `false` without logging — the expected state before the table exists.
 */
async function hasAnyTermAssignments(db: Kysely<Database>): Promise<boolean> {
	const cached = hasTermAssignmentsCache.get(db);
	if (cached !== undefined) return cached;

	try {
		const result = await sql<{ entry_id: string }>`
			SELECT entry_id FROM content_taxonomies LIMIT 1
		`.execute(db);
		const value = result.rows.length > 0;
		hasTermAssignmentsCache.set(db, value);
		return value;
	} catch (error) {
		if (isMissingTableError(error)) {
			hasTermAssignmentsCache.set(db, false);
			return false;
		}
		// Don't cache unknown failures; let the next call retry.
		throw error;
	}
}

/**
 * Get all taxonomy definitions
 */
export async function getTaxonomyDefs(): Promise<TaxonomyDef[]> {
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
}

/**
 * Get a single taxonomy definition by name
 */
export async function getTaxonomyDef(name: string): Promise<TaxonomyDef | null> {
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
}

/**
 * Get all terms for a taxonomy (as tree for hierarchical, flat for tags)
 */
export async function getTaxonomyTerms(taxonomyName: string): Promise<TaxonomyTerm[]> {
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

	// Count entries for each term
	const countsResult = await db
		.selectFrom("content_taxonomies")
		.select(["taxonomy_id"])
		.select((eb) => eb.fn.count<number>("entry_id").as("count"))
		.groupBy("taxonomy_id")
		.execute();

	const counts = new Map<string, number>();
	for (const row of countsResult) {
		counts.set(row.taxonomy_id, row.count);
	}

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

	// Get entry count
	const countResult = await db
		.selectFrom("content_taxonomies")
		.select((eb) => eb.fn.count<number>("entry_id").as("count"))
		.where("taxonomy_id", "=", row.id)
		.executeTakeFirst();

	const count = countResult?.count ?? 0;

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

	// Skip the query entirely when no assignments exist anywhere.
	if (!(await hasAnyTermAssignments(db))) {
		return result;
	}

	// Chunk the IN clause so we stay below D1's ~100 bound-parameter limit
	// (and equivalent limits on other dialects). Matches getContentBylinesMany.
	for (const chunk of chunks(uniqueIds, SQL_BATCH_SIZE)) {
		const rows = await db
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
 * Includes a short-circuit: when no term assignments exist in the database,
 * returns an empty Map without issuing a query. The cache is invalidated
 * on term create/update/delete (see invalidateTermCache).
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

	// Skip the query entirely when no assignments exist anywhere.
	if (!(await hasAnyTermAssignments(db))) {
		return result;
	}

	// Chunk the IN clause to stay below D1's ~100 bound-parameter limit
	// (and equivalent limits on other dialects). Matches getContentBylinesMany.
	for (const chunk of chunks(uniqueIds, SQL_BATCH_SIZE)) {
		const rows = await db
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

	return result;
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
