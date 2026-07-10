/**
 * FTS5 match-expression builder for structured (non-user-syntax) queries.
 *
 * Unlike `escapeQuery` in `query.ts` (which powers the public search API and
 * deliberately passes through FTS5 operators like AND/OR/NOT), this builder
 * treats the input as plain words: every term is double-quoted with interior
 * quotes escaped, so the result can never produce an FTS5 syntax error. Used
 * by the admin content-list filter, where the input is a filter box, not a
 * search-syntax field.
 */

const WHITESPACE_RE = /\s+/;
const DOUBLE_QUOTE_RE = /"/g;
const GLOB_SPECIAL_RE = /[[\]*?]/g;

/**
 * Build a prefix-matching FTS5 MATCH expression from free-form input.
 *
 * `hello wor` becomes `"hello"* "wor"*` — implicit AND with per-term prefix
 * matching. Returns `""` when the input contains no usable terms; callers
 * must fall back to their non-FTS path in that case.
 */
export function buildFtsPrefixMatch(input: string): string {
	const terms = input
		.trim()
		.split(WHITESPACE_RE)
		.map((term) => term.replace(DOUBLE_QUOTE_RE, '""'))
		.filter((term) => term.length > 0);

	if (terms.length === 0) return "";
	return terms.map((term) => `"${term}"*`).join(" ");
}

/**
 * Build a GLOB prefix pattern from free-form input, treating GLOB
 * metacharacters (`* ? [ ]`) literally by wrapping each in a character
 * class (GLOB has no ESCAPE clause).
 *
 * GLOB (unlike default LIKE) is case-sensitive, so with a lowercased
 * pattern it matches slugs (lowercase by construction) while staying
 * servable by the ordinary BINARY-collated slug index — SQLite's GLOB
 * optimization turns a `prefix*` pattern into an index range scan.
 */
export function buildSlugGlobPrefix(input: string): string {
	const escaped = input
		.trim()
		.toLowerCase()
		.replace(GLOB_SPECIAL_RE, (c) => `[${c}]`);
	return `${escaped}*`;
}
