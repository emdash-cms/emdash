/**
 * Search Query Functions
 *
 * Programmatic API for searching content using FTS5.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getDb } from "../loader.js";
import { FTSManager } from "./fts-manager.js";
import type {
	SearchOptions,
	CollectionSearchOptions,
	SearchResult,
	SearchResponse,
	SuggestOptions,
	Suggestion,
	SearchStats,
} from "./types.js";

/** Pattern to split on whitespace for query term extraction */
const WHITESPACE_SPLIT_PATTERN = /\s+/;
const FTS_OPERATORS_PATTERN = /\b(AND|OR|NOT|NEAR)\b/i;
const DOUBLE_QUOTE_PATTERN = /"/g;

/**
 * Search across multiple collections
 *
 * Public API that auto-injects the database.
 *
 * @param query - Search query (FTS5 syntax supported)
 * @param options - Search options
 * @returns Search results with pagination
 *
 * @example
 * ```typescript
 * import { search } from "emdash";
 *
 * const results = await search("hello world", {
 *   collections: ["posts", "pages"],
 *   limit: 20
 * });
 * ```
 */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const db = await getDb();
	return searchWithDb(db, query, options);
}

/**
 * Search across multiple collections (with explicit db)
 *
 * @internal Use `search()` in templates. This variant is for admin routes
 * that already have a database handle.
 *
 * @param db - Kysely database instance
 * @param query - Search query (FTS5 syntax supported)
 * @param options - Search options
 * @returns Search results with pagination
 */
export async function searchWithDb(
	db: Kysely<Database>,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const ftsManager = new FTSManager(db);
	const limit = options.limit ?? 20;
	const status = options.status ?? "published";

	// Get searchable collections
	let collections = options.collections;
	if (!collections || collections.length === 0) {
		collections = await getSearchableCollections(db);
	}

	if (collections.length === 0) {
		return { items: [] };
	}

	// Search each collection and merge results
	const allResults: SearchResult[] = [];

	for (const collection of collections) {
		const config = await ftsManager.getSearchConfig(collection);
		if (!config?.enabled) {
			continue;
		}

		const collectionResults = await searchSingleCollection(
			db,
			collection,
			query,
			{
				status,
				locale: options.locale,
				limit: limit * 2, // Get extra for merging
			},
			config.weights,
		);

		allResults.push(...collectionResults);
	}

	// Sort by score descending
	allResults.sort((a, b) => b.score - a.score);

	// Apply limit
	const items = allResults.slice(0, limit);

	return { items };
}

/**
 * Search within a single collection
 *
 * @param db - Kysely database instance
 * @param collection - Collection slug
 * @param query - Search query (FTS5 syntax supported)
 * @param options - Search options
 * @returns Search results with pagination
 *
 * @example
 * ```typescript
 * const results = await searchCollection(db, "posts", "hello world", {
 *   limit: 10
 * });
 * ```
 */
export async function searchCollection(
	db: Kysely<Database>,
	collection: string,
	query: string,
	options: CollectionSearchOptions = {},
): Promise<SearchResponse> {
	const ftsManager = new FTSManager(db);
	const config = await ftsManager.getSearchConfig(collection);

	if (!config?.enabled) {
		return { items: [] };
	}

	const items = await searchSingleCollection(db, collection, query, options, config.weights);

	return { items };
}

/**
 * Internal function to search a single collection
 */
async function searchSingleCollection(
	db: Kysely<Database>,
	collection: string,
	query: string,
	options: CollectionSearchOptions,
	weights?: Record<string, number>,
): Promise<SearchResult[]> {
	// Validate before any raw SQL interpolation
	validateIdentifier(collection, "collection slug");

	const ftsManager = new FTSManager(db);
	const ftsTable = ftsManager.getFtsTableName(collection);
	const contentTable = ftsManager.getContentTableName(collection);
	const limit = options.limit ?? 20;
	const status = options.status ?? "published";
	const locale = options.locale;

	// Check if FTS table exists
	if (!(await ftsManager.ftsTableExists(collection))) {
		return [];
	}

	// Escape the query for FTS5
	const escapedQuery = escapeQuery(query);
	if (!escapedQuery) {
		return [];
	}

	// Get searchable fields for snippet generation
	const searchableFields = await ftsManager.getSearchableFields(collection);

	// Build weight string for bm25 if weights provided
	// Format: bm25(table, weight1, weight2, ...)
	// First two weights are for 'id' and 'locale' columns (UNINDEXED, so 0)
	let bm25Args = "";
	if (weights && searchableFields.length > 0) {
		const weightValues = ["0", "0"]; // id column, locale column
		for (const field of searchableFields) {
			weightValues.push(String(weights[field] ?? 1));
		}
		bm25Args = weightValues.join(", ");
	}

	// Build and execute the search query
	// Using raw SQL because Kysely doesn't have FTS5 support
	const bm25Expr = bm25Args ? `bm25("${ftsTable}", ${bm25Args})` : `bm25("${ftsTable}")`;

	// Snippet column index is 2 (after id=0, locale=1, first searchable field=2)
	const results = await sql<{
		id: string;
		slug: string | null;
		locale: string;
		title: string | null;
		snippet: string;
		score: number;
	}>`
		SELECT 
			c.id,
			c.slug,
			c.locale,
			c.title,
			snippet("${sql.raw(ftsTable)}", 2, '<mark>', '</mark>', '...', 32) as snippet,
			${sql.raw(bm25Expr)} as score
		FROM "${sql.raw(ftsTable)}" f
		JOIN "${sql.raw(contentTable)}" c ON f.id = c.id
		WHERE "${sql.raw(ftsTable)}" MATCH ${escapedQuery}
		AND c.status = ${status}
		AND c.deleted_at IS NULL
		${locale ? sql`AND c.locale = ${locale}` : sql``}
		ORDER BY score
		LIMIT ${limit}
	`.execute(db);

	return results.rows.map((row) => ({
		collection,
		id: row.id,
		slug: row.slug,
		locale: row.locale,
		title: row.title ?? undefined,
		snippet: row.snippet,
		score: Math.abs(row.score), // bm25 returns negative scores
	}));
}

/**
 * Get search suggestions for autocomplete
 *
 * @param db - Kysely database instance
 * @param query - Partial search query
 * @param options - Suggestion options
 * @returns Array of suggestions
 */
export async function getSuggestions(
	db: Kysely<Database>,
	query: string,
	options: SuggestOptions = {},
): Promise<Suggestion[]> {
	const limit = options.limit ?? 5;
	const locale = options.locale;

	// Get searchable collections
	let collections = options.collections;
	if (!collections || collections.length === 0) {
		collections = await getSearchableCollections(db);
	}

	if (collections.length === 0) {
		return [];
	}

	const suggestions: Suggestion[] = [];

	for (const collection of collections) {
		const ftsManager = new FTSManager(db);
		const config = await ftsManager.getSearchConfig(collection);
		if (!config?.enabled) {
			continue;
		}

		// Validate before raw SQL interpolation
		validateIdentifier(collection, "collection slug");

		const ftsTable = ftsManager.getFtsTableName(collection);
		const contentTable = ftsManager.getContentTableName(collection);

		// Use prefix search for autocomplete
		const prefixQuery = `${escapeQuery(query)}*`;
		if (!prefixQuery || prefixQuery === "*") {
			continue;
		}

		const results = await sql<{
			id: string;
			title: string;
		}>`
			SELECT 
				c.id,
				c.title
			FROM "${sql.raw(ftsTable)}" f
			JOIN "${sql.raw(contentTable)}" c ON f.id = c.id
			WHERE "${sql.raw(ftsTable)}" MATCH ${prefixQuery}
			AND c.status = 'published'
			AND c.deleted_at IS NULL
			AND c.title IS NOT NULL
			${locale ? sql`AND c.locale = ${locale}` : sql``}
			ORDER BY bm25("${sql.raw(ftsTable)}")
			LIMIT ${limit}
		`.execute(db);

		for (const row of results.rows) {
			suggestions.push({
				collection,
				id: row.id,
				title: row.title,
			});
		}
	}

	return suggestions.slice(0, limit);
}

/**
 * Get search statistics for all collections
 */
export async function getSearchStats(db: Kysely<Database>): Promise<SearchStats> {
	const ftsManager = new FTSManager(db);
	const collections = await getSearchableCollections(db);
	const stats: SearchStats = { collections: {} };

	for (const collection of collections) {
		const collectionStats = await ftsManager.getIndexStats(collection);
		if (collectionStats) {
			stats.collections[collection] = collectionStats;
		}
	}

	return stats;
}

/**
 * Get list of collections with search enabled
 */
async function getSearchableCollections(db: Kysely<Database>): Promise<string[]> {
	const results = await db
		.selectFrom("_emdash_collections")
		.select(["slug", "search_config"])
		.execute();

	return results
		.filter((r) => {
			if (!r.search_config) return false;
			try {
				const config = JSON.parse(r.search_config);
				return config.enabled === true;
			} catch {
				return false;
			}
		})
		.map((r) => r.slug);
}

/**
 * Escape a query string for FTS5
 *
 * Handles special characters and prevents injection.
 */
function escapeQuery(query: string): string {
	if (!query || typeof query !== "string") {
		return "";
	}

	// Trim whitespace
	query = query.trim();

	if (query.length === 0) {
		return "";
	}

	// If already a quoted phrase, escape only interior quotes and preserve phrase syntax
	if (query.startsWith('"') && query.endsWith('"') && query.length >= 2) {
		const inner = query.slice(1, -1);
		return `"${inner.replace(DOUBLE_QUOTE_PATTERN, '""')}"`;
	}

	// Escape any existing quotes
	const escaped = query.replace(DOUBLE_QUOTE_PATTERN, '""');

	// If the query contains FTS5 operators (AND, OR, NOT, NEAR),
	// pass through with quotes escaped but operators preserved
	if (FTS_OPERATORS_PATTERN.test(query)) {
		return escaped;
	}

	// For simple queries, wrap each word to handle special chars
	const terms = escaped.split(WHITESPACE_SPLIT_PATTERN).filter((t) => t.length > 0);
	if (terms.length === 0) {
		return "";
	}

	// Join with implicit AND, add prefix matching (*) to all terms
	// This allows "hel wor" to match "hello world"
	return terms.map((t) => `"${t}"*`).join(" ");
}
