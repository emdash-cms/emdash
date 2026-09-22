/**
 * Search Module
 *
 * Full-text search for EmDash using SQLite FTS5.
 */

// Types
export type {
	SearchConfig,
	SearchTokenizer,
	SearchOptions,
	CollectionSearchOptions,
	SearchResult,
	SearchResponse,
	SuggestOptions,
	Suggestion,
	SearchStats,
} from "./types.js";
export { SEARCH_TOKENIZERS } from "./types.js";

// FTS Manager
export { FTSManager } from "./fts-manager.js";

// Query functions (public API uses getDb() internally)
export { search, searchWithDb, searchCollection, getSuggestions, getSearchStats } from "./query.js";

// Text extraction
export { extractPlainText, extractSearchableFields } from "./text-extraction.js";
