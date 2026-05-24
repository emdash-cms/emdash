/**
 * Taxonomy term matching for the admin picker.
 *
 * The picker filters an editor's typed input against existing terms. A naive
 * `label.toLowerCase().includes(input.toLowerCase())` fails the accent case:
 * typing `"Mexico"` does not substring-match a term labeled `"México"`
 * because `"méxico".toLowerCase()` is still `"méxico"` and
 * `"méxico".includes("mexico")` is `false`. The editor then sees zero
 * suggestions and creates a duplicate `"Mexico"` term alongside the
 * canonical `"México"`, splitting the taxonomy.
 *
 * This module folds diacritics via NFD decomposition before substring
 * matching. No regexes are compiled from user input, so there is no ReDoS
 * surface.
 */

const DIACRITIC_RANGE = /[\u0300-\u036f]/g;

/**
 * Case-fold + diacritic-fold normalization for substring matching.
 *
 * `"México"`, `"mexico"`, `"MÉXICO"` all collapse to `"mexico"`.
 *
 * NFD decomposes accented characters into a base + combining-diacritic
 * sequence; the regex drops the combiners. Greek tonos, Vietnamese
 * stacked diacritics, and other Latin-adjacent scripts are covered.
 * Combining marks used meaningfully in non-Latin scripts (Arabic harakat
 * U+064B–U+0652, Japanese dakuten U+3099) fall outside the U+0300–036F
 * block and are left untouched — stripping them would change meaning.
 */
export function foldForMatch(value: string): string {
	return value.normalize("NFD").replace(DIACRITIC_RANGE, "").toLowerCase();
}

/**
 * Minimal shape a term must have to participate in matching.
 * Kept structural so picker components and tests can use plain objects.
 */
export interface MatchableTerm {
	label: string;
}

/**
 * True if `input` is a substring of the term's label, ignoring case and
 * diacritics.
 *
 * Empty or whitespace-only input returns `false` — the caller decides
 * whether to show all terms or none in that state. The whitespace guard
 * matters: without it, a needle of `"   "` would `.includes()`-match
 * every term whose label contains a space.
 */
export function termMatches(term: MatchableTerm, input: string): boolean {
	const needle = foldForMatch(input).trim();
	if (!needle) return false;
	return foldForMatch(term.label).includes(needle);
}

/**
 * True if `input` is an exact (fold-equal) match for the term's label.
 * Used to decide whether to show the "Create new term" button — if an
 * editor types `"Mexico"` and a term labeled `"México"` already exists,
 * Create must not appear or they'll produce a duplicate.
 */
export function termExactMatches(term: MatchableTerm, input: string): boolean {
	const needle = foldForMatch(input).trim();
	if (!needle) return false;
	return foldForMatch(term.label).trim() === needle;
}
