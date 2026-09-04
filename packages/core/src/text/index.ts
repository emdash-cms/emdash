/**
 * Unicode text normalization for search and sorting.
 *
 * `normalize.ts` holds the folds both pipelines must share, because the same
 * transformation has to run at FTS index time, at FTS query time, and when a
 * sort key is written. The two terminal stages diverge from there:
 * `search-key.ts` folds aggressively for recall over a rebuildable index,
 * `sort-key.ts` produces a persisted key whose binary comparison reproduces
 * alphabetical order.
 */

export { foldLatinExpansions, foldMarks, normalizeText } from "./normalize.js";
export { resolveCollation, TAILORED_LOCALES } from "./collation.js";
export {
	searchIndexText,
	searchNormalize,
	searchTokens,
	SEARCH_KEY_VERSION,
} from "./search-key.js";
export { sortKey, SORT_KEY_MAX_LENGTH, SORT_KEY_VERSION } from "./sort-key.js";

export type { NormalizeOptions } from "./normalize.js";
export type { Collation } from "./collation.js";
export type { SortKeyOptions } from "./sort-key.js";
