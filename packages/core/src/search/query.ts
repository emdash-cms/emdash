/**
 * Search Query Functions
 *
 * Programmatic API for searching content using FTS5.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { encodeCursor, decodeCursor, InvalidCursorError } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { resolveConfiguredLocale } from "../i18n/config.js";
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

/**
 * Marker stored in the `id` slot of a search pagination cursor.
 *
 * Search results are merged from per-collection FTS queries and re-sorted by
 * score, so there is no single stable keyset column to encode (the way
 * `getEmDashCollection` encodes `(orderValue, id)`). We page over the merged,
 * score-sorted set by offset instead, carried as the cursor's `orderValue`.
 * Reusing `encodeCursor`/`decodeCursor` keeps the opaque base64-JSON shape and
 * the `InvalidCursorError` handling consistent with the rest of the API.
 */
const SEARCH_CURSOR_MARKER = "search";

/** Encode the next-page offset into an opaque search cursor. */
function encodeSearchCursor(offset: number): string {
	return encodeCursor(String(offset), SEARCH_CURSOR_MARKER);
}

/**
 * Decode a search cursor back to its offset. Throws `InvalidCursorError` for a
 * malformed cursor or one that doesn't carry a non-negative integer offset, so
 * a client pagination bug surfaces immediately rather than silently restarting
 * from the first page.
 */
/** Upper bound on a decoded search offset, to cap the per-collection row fetch a forged cursor can trigger. */
const MAX_SEARCH_OFFSET = 10_000;

function decodeSearchOffset(cursor: string): number {
	const { orderValue, id } = decodeCursor(cursor);
	if (id !== SEARCH_CURSOR_MARKER) {
		throw new InvalidCursorError(cursor);
	}
	const offset = Number(orderValue);
	if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SEARCH_OFFSET) {
		throw new InvalidCursorError(cursor);
	}
	return offset;
}

/** Pattern to split on whitespace for query term extraction */
const WHITESPACE_SPLIT_PATTERN = /\s+/;
// FTS5 operators are uppercase-only; a case-insensitive match would treat
// ordinary words as syntax and skip the safe quoting path below.
const FTS_OPERATORS_PATTERN = /\b(AND|OR|NOT|NEAR)\b/;
const DOUBLE_QUOTE_PATTERN = /"/g;

/**
 * Detect FTS5 query syntax errors. Match specifically on the SQLite FTS5
 * error fingerprints rather than a broad "fts5" / "syntax error" filter
 * (which would also swallow internal table-corruption errors). The two
 * fingerprints we care about are:
 *
 *  - "fts5: syntax error near …" — unbalanced quotes, stray operators,
 *    other malformed user input
 *  - "unknown special query: …" — bare special tokens like `^*` that
 *    parse but don't resolve to a real FTS5 directive
 */
function isFts5SyntaxError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes("fts5: syntax error") || message.includes("unknown special query");
}

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
	const offset = options.cursor ? decodeSearchOffset(options.cursor) : 0;

	// Get searchable collections
	let collections = options.collections;
	if (!collections || collections.length === 0) {
		collections = await getSearchableCollections(db);
	}

	if (collections.length === 0) {
		return { items: [] };
	}

	// To rank the merged window [offset, offset + limit) correctly, each
	// collection must contribute its own top (offset + limit) rows — in the
	// worst case the entire window comes from one collection. The extra +1
	// row detects whether a further page exists.
	const perCollectionLimit = offset + limit + 1;

	// Search each collection and merge results
	const allResults: SearchResult[] = [];
	const titleColumns = await ftsManager.getCollectionsWithTitleColumn(collections);

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
				limit: perCollectionLimit,
				scope: options.scope,
			},
			config.weights,
			titleColumns.has(collection),
			config.titleField,
		);

		allResults.push(...collectionResults);
	}

	// BM25 scores are computed per FTS5 table, so raw values are on different
	// scales across collections. Normalize each result against its
	// collection's best score and then rank by title-match quality. Without
	// this, a larger collection's passing mentions can outrank an exact title
	// match in a smaller collection because the larger table's IDF is higher.
	normalizeScoresPerCollection(allResults);
	const titleTiers = new Map<SearchResult, TitleMatchTier>();
	for (const result of allResults) {
		titleTiers.set(result, classifyTitleMatch(result.title, query));
	}

	allResults.sort((a, b) => {
		const tierA = titleTiers.get(a) ?? TITLE_MATCH_TIER.None;
		const tierB = titleTiers.get(b) ?? TITLE_MATCH_TIER.None;
		if (tierB !== tierA) {
			return tierB - tierA;
		}
		return b.score - a.score;
	});

	// Page the merged set by offset. A nextCursor is issued only when at least
	// one result exists past this page.
	const items = allResults.slice(offset, offset + limit);
	const hasMore = allResults.length > offset + limit;
	const nextCursor = hasMore ? encodeSearchCursor(offset + limit) : undefined;

	return { items, nextCursor };
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

	const limit = options.limit ?? 20;
	const offset = options.cursor ? decodeSearchOffset(options.cursor) : 0;

	// Over-fetch the [offset, offset + limit) window plus one row to detect a
	// further page, then slice. Keeps the FTS SQL (LIMIT-only) unchanged and
	// the cursor contract identical to the cross-collection path.
	const fetched = await searchSingleCollection(
		db,
		collection,
		query,
		{
			status: options.status,
			locale: options.locale,
			limit: offset + limit + 1,
			scope: options.scope,
		},
		config.weights,
		undefined,
		config.titleField,
	);

	const items = fetched.slice(offset, offset + limit);
	const hasMore = fetched.length > offset + limit;
	const nextCursor = hasMore ? encodeSearchCursor(offset + limit) : undefined;

	return { items, nextCursor };
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
	hasTitle?: boolean,
	titleField?: string,
): Promise<SearchResult[]> {
	// Validate before any raw SQL interpolation
	validateIdentifier(collection, "collection slug");

	const ftsManager = new FTSManager(db);
	const ftsTable = ftsManager.getFtsTableName(collection);
	const contentTable = ftsManager.getContentTableName(collection);
	const limit = options.limit ?? 20;
	const status = options.status ?? "published";
	const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;

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

	// Title scope restricts the FTS5 match to the collection's title column.
	// The scoped column must be one of the indexed searchable fields; a
	// collection whose title is not indexed cannot match by title. Operators
	// are disabled so every term stays quoted inside the filter's group.
	let matchQuery = escapedQuery;
	if (options.scope === "title") {
		const titleColumn =
			titleField && searchableFields.includes(titleField)
				? titleField
				: searchableFields.includes("title")
					? "title"
					: undefined;
		if (!titleColumn) {
			return [];
		}
		validateIdentifier(titleColumn, "title field");
		matchQuery = `${titleColumn} : (${escapeQuery(query, false)})`;
	}

	// `title` is an optional user-defined field, not a system column. Only
	// select it when the collection actually has one; otherwise the query
	// errors with "no such column: c.title". Multi-collection callers
	// precompute this in bulk and pass it in; single-collection callers fall
	// back to the per-collection check.
	// A configured titleField drives the result title so search shows
	// the same value as the content list. It's a validated existing field, so
	// the column exists; otherwise fall back to the optional `title` column.
	let titleExpr;
	if (titleField) {
		validateIdentifier(titleField, "title field");
		titleExpr = sql`c.${sql.ref(titleField)}`;
	} else {
		const collectionHasTitle = hasTitle ?? (await ftsManager.hasTitleColumn(collection));
		titleExpr = collectionHasTitle ? sql`c.title` : sql`NULL`;
	}

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
	let results;
	try {
		results = await sql<{
			id: string;
			slug: string | null;
			locale: string;
			title: string | null;
			snippet: string | null;
			score: number;
		}>`
		SELECT
			c.id,
			c.slug,
			c.locale,
			${titleExpr} as title,
			snippet("${sql.raw(ftsTable)}", 2, '<mark>', '</mark>', '...', 32) as snippet,
			${sql.raw(bm25Expr)} as score
		FROM "${sql.raw(ftsTable)}" f
		JOIN "${sql.raw(contentTable)}" c ON f.id = c.id
		WHERE "${sql.raw(ftsTable)}" MATCH ${matchQuery}
		AND c.status = ${status}
		AND c.deleted_at IS NULL
		${locale ? sql`AND c.locale = ${locale}` : sql``}
		ORDER BY score
		LIMIT ${limit}
	`.execute(db);
	} catch (error) {
		// FTS5 returns syntax errors for queries with unbalanced quotes,
		// stray operators, or other malformed input. Treat these as
		// "no matches" so the user gets an empty result rather than an
		// internals-leaking error. Other errors (table missing, IO) still
		// propagate. Intentionally not logged: any anonymous client can
		// trigger this path, and the underlying error message embeds the
		// raw query, so logging would be both noisy and a log-injection
		// vector.
		if (isFts5SyntaxError(error)) {
			return [];
		}
		throw error;
	}

	return results.rows.map((row) => ({
		collection,
		id: row.id,
		slug: row.slug,
		locale: row.locale,
		title: row.title ?? undefined,
		// SQLite's snippet() returns NULL when the targeted column is
		// NULL for that row — even if the row matched via a different
		// searchable column. Skip sanitization in that case so we don't
		// throw on `null.replace`. The SearchResult.snippet field is
		// already optional, so omitting it is the documented contract.
		snippet: row.snippet === null ? undefined : sanitizeSnippet(row.snippet),
		score: Math.abs(row.score), // bm25 returns negative scores
	}));
}

// Module-scope regexes so the engine doesn't recompile per call —
// snippet sanitization runs on every search result.
const SNIPPET_AMP_RE = /&/g;
const SNIPPET_LT_RE = /</g;
const SNIPPET_GT_RE = />/g;
const SNIPPET_QUOT_RE = /"/g;
const SNIPPET_APOS_RE = /'/g;

/**
 * Make an FTS5 snippet safe to render with `set:html` / `innerHTML`.
 *
 * SQLite's `snippet()` function splices literal `<mark>` and `</mark>`
 * markers around matched terms but does not escape the surrounding
 * source text. Posts that legitimately contain `<`, `>`, `&`, `"` or
 * `'` would render as broken markup, and a `<script>` literal in a
 * title (or any other indexed field) would execute when displayed.
 *
 * The fix: HTML-escape the whole string, which turns the markers into
 * `&lt;mark&gt;` / `&lt;/mark&gt;`. Then restore those two patterns to
 * their original tag form. The result is "the indexed text with all
 * HTML metacharacters escaped, plus a small set of literal `<mark>`
 * highlight tags around matched terms" — which matches the API's
 * documented contract.
 */
function sanitizeSnippet(snippet: string): string {
	return snippet
		.replace(SNIPPET_AMP_RE, "&amp;")
		.replace(SNIPPET_LT_RE, "&lt;")
		.replace(SNIPPET_GT_RE, "&gt;")
		.replace(SNIPPET_QUOT_RE, "&quot;")
		.replace(SNIPPET_APOS_RE, "&#39;")
		.replaceAll("&lt;mark&gt;", "<mark>")
		.replaceAll("&lt;/mark&gt;", "</mark>");
}

// Operator words are ordinary search terms in lowercase, but when they appear
// alone in a query string they are interpreted as FTS5 syntax. Strip them
// from the title-match heuristic so a search like "boarding and wil" doesn't
// require the word "and" to be present in a title.
const TITLE_MATCH_OPERATOR_WORDS = new Set(["and", "or", "not", "near"]);

const TITLE_MATCH_TIER = {
	None: 0,
	Contains: 1,
	Exact: 2,
} as const;

type TitleMatchTier = (typeof TITLE_MATCH_TIER)[keyof typeof TITLE_MATCH_TIER];

/**
 * Pull searchable words out of the raw query string for title matching.
 *
 * Surrounding quotes on a phrase query are removed so the whole phrase can
 * match a title, and any trailing prefix wildcard (`*`) inserted by
 * `escapeQuery` is stripped. Punctuation is trimmed from the ends of each
 * term; operator words are dropped because they are syntax, not required
 * words.
 */
function extractQueryTerms(query: string): string[] {
	const lowered = query.trim().toLowerCase();
	if (lowered.startsWith('"') && lowered.endsWith('"')) {
		return [lowered.slice(1, -1).trim()].filter((t) => t.length > 0);
	}
	return lowered
		.split(WHITESPACE_SPLIT_PATTERN)
		.map(trimNonAlphanumeric)
		.filter((term) => term.length > 0 && !TITLE_MATCH_OPERATOR_WORDS.has(term));
}

function isAlphanumeric(charCode: number): boolean {
	return (
		(charCode >= 0x30 && charCode <= 0x39) || // 0-9
		(charCode >= 0x41 && charCode <= 0x5a) || // A-Z
		(charCode >= 0x61 && charCode <= 0x7a) // a-z
	);
}

function trimNonAlphanumeric(term: string): string {
	let start = 0;
	let end = term.length;
	while (start < end && !isAlphanumeric(term.charCodeAt(start))) {
		start++;
	}
	while (end > start && !isAlphanumeric(term.charCodeAt(end - 1))) {
		end--;
	}
	return term.slice(start, end);
}

/**
 * Classify how strongly a result title matches the original query.
 *
 * Exact title matches rank above titles that merely contain all query
 * terms; everything else falls into the lowest tier. This prevents an exact
 * title hit in one collection from being buried below passing mentions in
 * another collection because the two collections' bm25 scores are not
 * comparable.
 */
function classifyTitleMatch(title: string | undefined, query: string): TitleMatchTier {
	if (!title) {
		return TITLE_MATCH_TIER.None;
	}
	const normalizedTitle = title.trim().toLowerCase();
	const normalizedQuery = query.trim().toLowerCase().replace(/^"|"$/g, "");
	if (normalizedTitle === normalizedQuery) {
		return TITLE_MATCH_TIER.Exact;
	}
	const terms = extractQueryTerms(query);
	if (terms.length > 0 && terms.every((term) => normalizedTitle.includes(term))) {
		return TITLE_MATCH_TIER.Contains;
	}
	return TITLE_MATCH_TIER.None;
}

const SCORE_NORMALIZATION_EPSILON = 1e-9;

/**
 * Normalize per-collection bm25 scores so they can be compared across
 * collections.
 *
 * Each FTS5 table computes bm25 from its own document frequencies, so the
 * absolute numbers are only meaningful inside one collection. Dividing each
 * result by the best score in its collection maps every collection's top hit
 * to 1. Title-match tiers then provide the rank ordering that bm25 alone cannot.
 */
function normalizeScoresPerCollection(results: SearchResult[]): void {
	const maxByCollection = new Map<string, number>();
	for (const result of results) {
		maxByCollection.set(
			result.collection,
			Math.max(maxByCollection.get(result.collection) ?? 0, result.score),
		);
	}
	for (const result of results) {
		const max = maxByCollection.get(result.collection) ?? 0;
		if (max <= SCORE_NORMALIZATION_EPSILON) {
			result.score = 0;
		} else {
			result.score = result.score / max;
		}
	}
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
	const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;

	// Get searchable collections
	let collections = options.collections;
	if (!collections || collections.length === 0) {
		collections = await getSearchableCollections(db);
	}

	if (collections.length === 0) {
		return [];
	}

	const suggestions: Suggestion[] = [];
	const ftsManager = new FTSManager(db);
	const titleColumns = await ftsManager.getCollectionsWithTitleColumn(collections);

	for (const collection of collections) {
		const config = await ftsManager.getSearchConfig(collection);
		if (!config?.enabled) {
			continue;
		}

		// Suggestions are title-based (Suggestion.title is required). A configured
		// titleField supplies it -- a validated existing column -- so it
		// takes precedence and keeps autocomplete consistent with search results.
		// Otherwise fall back to the optional `title` field; collections with
		// neither can't produce a suggestion and are skipped (selecting a missing
		// column would error).
		let titleExpr;
		if (config.titleField) {
			validateIdentifier(config.titleField, "title field");
			titleExpr = sql`c.${sql.ref(config.titleField)}`;
		} else if (titleColumns.has(collection)) {
			titleExpr = sql`c.title`;
		} else {
			continue;
		}

		// Validate before raw SQL interpolation
		validateIdentifier(collection, "collection slug");

		const ftsTable = ftsManager.getFtsTableName(collection);
		const contentTable = ftsManager.getContentTableName(collection);

		// Use prefix search for autocomplete. `escapeQuery` already appends `*`
		// to each term for prefix matching, so we must not append another one.
		const prefixQuery = escapeQuery(query);
		if (!prefixQuery) {
			continue;
		}

		let results;
		try {
			results = await sql<{
				id: string;
				slug: string | null;
				title: string;
			}>`
				SELECT
					c.id,
					c.slug,
					${titleExpr} AS title
				FROM "${sql.raw(ftsTable)}" f
				JOIN "${sql.raw(contentTable)}" c ON f.id = c.id
				WHERE "${sql.raw(ftsTable)}" MATCH ${prefixQuery}
				AND c.status = 'published'
				AND c.deleted_at IS NULL
				AND ${titleExpr} IS NOT NULL
				${locale ? sql`AND c.locale = ${locale}` : sql``}
				ORDER BY bm25("${sql.raw(ftsTable)}")
				LIMIT ${limit}
			`.execute(db);
		} catch (error) {
			// Same swallow as searchSingleCollection: malformed prefix
			// queries should yield no suggestions, not surface DB errors.
			// Intentionally not logged (anonymous-triggerable, echoes
			// user input -- see searchSingleCollection for rationale).
			if (isFts5SyntaxError(error)) {
				continue;
			}
			throw error;
		}

		for (const row of results.rows) {
			suggestions.push({
				collection,
				id: row.id,
				slug: row.slug,
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
function escapeQuery(query: string, allowOperators = true): string {
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
	// pass through with quotes escaped but operators preserved. Not allowed
	// when the match string is embedded in a column filter: unquoted parens
	// would let a clause escape the filter's group.
	if (allowOperators && FTS_OPERATORS_PATTERN.test(query)) {
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
