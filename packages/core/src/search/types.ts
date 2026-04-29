/**
 * Search Types
 *
 * Type definitions for the EmDash search system.
 */

/**
 * Search configuration for a collection
 */
export interface SearchConfig {
	/** Whether search is enabled for this collection */
	enabled: boolean;
	/** Field weights for ranking (higher = more important) */
	weights?: Record<string, number>;
}

/**
 * Options for search queries
 */
export interface SearchOptions {
	/** Collections to search (defaults to all searchable collections) */
	collections?: string[];
	/** Filter by content status (defaults to 'published') */
	status?: string;
	/** Filter by locale (omit to search all locales) */
	locale?: string;
	/** Maximum results to return (defaults to 20) */
	limit?: number;
	/** Pagination cursor */
	cursor?: string;
}

/**
 * Options for collection-specific search
 */
export interface CollectionSearchOptions {
	/** Filter by content status (defaults to 'published') */
	status?: string;
	/** Filter by locale (omit to search all locales) */
	locale?: string;
	/** Maximum results to return (defaults to 20) */
	limit?: number;
	/** Pagination cursor */
	cursor?: string;
}

/**
 * A single search result
 */
export interface SearchResult {
	/** Collection the result belongs to */
	collection: string;
	/** Entry ID */
	id: string;
	/** Entry slug */
	slug: string | null;
	/** Content locale */
	locale: string;
	/** Entry title (if available) */
	title?: string;
	/**
	 * Highlighted snippet showing match context.
	 *
	 * Sanitized server-side to be safe for `set:html` / `innerHTML`:
	 * all HTML metacharacters in the source text are escaped, and
	 * matched terms are wrapped in literal `<mark>...</mark>` tags
	 * (the only HTML the snippet is allowed to contain).
	 */
	snippet?: string;
	/** Relevance score (higher = more relevant) */
	score: number;
}

/**
 * Response from a search query
 */
export interface SearchResponse {
	/** Search results */
	items: SearchResult[];
	/** Cursor for next page of results */
	nextCursor?: string;
}

/**
 * Options for suggestion/autocomplete queries
 */
export interface SuggestOptions {
	/** Collections to search (defaults to all searchable collections) */
	collections?: string[];
	/** Filter by locale (omit to search all locales) */
	locale?: string;
	/** Maximum suggestions to return (defaults to 5) */
	limit?: number;
}

/**
 * A single suggestion result
 */
export interface Suggestion {
	/** Collection the suggestion belongs to */
	collection: string;
	/** Entry ID */
	id: string;
	/** Entry title */
	title: string;
}

/**
 * Search index statistics
 */
export interface SearchStats {
	collections: Record<
		string,
		{
			/** Number of indexed entries */
			indexed: number;
			/** When the index was last rebuilt */
			lastRebuilt?: string;
		}
	>;
}
