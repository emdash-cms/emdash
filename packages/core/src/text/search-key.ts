import { foldLatinExpansions, foldMarks, normalizeText } from "./normalize.js";

/**
 * Text preparation for the search pipeline.
 *
 * Folding here is deliberately more aggressive than in `sort-key.ts`: search
 * trades precision for recall, and collisions are harmless because a
 * near-miss just returns an extra row. The FTS index is derived and
 * rebuildable (`FtsManager.rebuildIndex`), so changing this module costs a
 * reindex rather than a migration.
 *
 * Case folding is always locale-invariant, so `İSTANBUL` matches `istanbul`
 * whatever locale the searcher is in. That is the opposite of what sorting
 * wants for Turkish, and is the clearest reason the two pipelines share a
 * normalization core but not a single function.
 *
 * Stemming is not done here. FTS5's `porter unicode61` tokenizer stems the
 * already-normalized text inside SQLite; what is often called "Arabic
 * stemming" -- harakat removal, alef and yeh unification, digit folding -- is
 * normalization and happens in `normalizeText`.
 */

/** Bump when output changes; stale indexes need `rebuildIndex`, not a migration. */
export const SEARCH_KEY_VERSION = 1;

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * Scripts that do not delimit words with spaces. FTS5's `unicode61` tokenizer
 * would swallow a whole Thai or Chinese sentence as one token, so runs in
 * these scripts are indexed as overlapping bigrams instead.
 */
const UNSEGMENTED_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u;

/** Ta marbuta to heh: raises recall on Arabic names, merges distinct words. */
const TA_MARBUTA_RE = /\u0629/g;

/**
 * Fold text for matching.
 *
 * Runs the shared normalization, then strips combining marks, expands Latin
 * letters that have no decomposition, and applies the recall-oriented Arabic
 * folds. Suitable for `LIKE`/`GLOB` comparisons as well as FTS.
 */
export function searchNormalize(text: string): string {
	return foldLatinExpansions(foldMarks(normalizeText(text))).replace(TA_MARBUTA_RE, "\u0647");
}

function bigrams(run: string): string[] {
	// oxlint-disable-next-line typescript/no-misused-spread -- bigrams are pairs of code points
	const chars = [...run];
	if (chars.length < 2) return chars;

	const out: string[] = [];
	for (let i = 0; i + 1 < chars.length; i++) {
		out.push(`${chars[i] ?? ""}${chars[i + 1] ?? ""}`);
	}
	return out;
}

/** Split a word into maximal runs that are either all unsegmented or none. */
function segmentWord(word: string): string[] {
	const tokens: string[] = [];
	let run = "";
	let runUnsegmented = false;

	const flush = () => {
		if (run === "") return;
		if (runUnsegmented) tokens.push(...bigrams(run));
		else tokens.push(run);
		run = "";
	};

	for (const ch of word) {
		const unsegmented = UNSEGMENTED_RE.test(ch);
		if (run !== "" && unsegmented !== runUnsegmented) flush();
		runUnsegmented = unsegmented;
		run += ch;
	}
	flush();

	return tokens;
}

/**
 * Tokenize text for indexing or querying.
 *
 * Duplicates are preserved -- term frequency drives FTS5 ranking. Returns an
 * empty array when the input holds no usable characters, which is the
 * caller's signal to fall back to its non-FTS path rather than build an empty
 * `MATCH` expression.
 */
export function searchTokens(text: string): string[] {
	const normalized = searchNormalize(text);
	const tokens: string[] = [];
	for (const [word] of normalized.matchAll(WORD_RE)) {
		tokens.push(...segmentWord(word));
	}
	return tokens;
}

/**
 * Render text as the space-delimited string to store in an FTS5 column, or to
 * feed a `MATCH` expression builder.
 *
 * Both sides must go through this function: bigram tokens only match if the
 * query is segmented the same way the index was.
 */
export function searchIndexText(text: string): string {
	return searchTokens(text).join(" ");
}
