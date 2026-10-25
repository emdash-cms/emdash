const MISSING_FTS5_PATTERN = /no such (?:module: fts5\b|function: bm25\b)/i;

/** Search requires SQLite's FTS5 extension, which some Node builds omit. */
export class SearchUnavailableError extends Error {
	readonly code = "SEARCH_UNAVAILABLE";

	constructor(cause: unknown) {
		super(
			"Search is unavailable because this SQLite build does not include FTS5. " +
				"Use a SQLite build with FTS5 support, then enable search for the affected collections.",
			{ cause },
		);
		this.name = "SearchUnavailableError";
	}
}

export function normalizeSearchError(error: unknown): unknown {
	if (error instanceof Error && MISSING_FTS5_PATTERN.test(error.message)) {
		return new SearchUnavailableError(error);
	}
	return error;
}
