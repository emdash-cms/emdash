// Regex patterns for sort-key normalization
const COMBINING_MARK_PATTERN = /\p{Mn}/gu;
const LATIN_EXPANSION_PATTERN = /[æœøðþßđłħıŋŧĸ]/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Latin letters that carry no combining mark to strip, so NFD leaves them
 * above `z` in code-point order.
 */
const LATIN_EXPANSIONS: Record<string, string> = {
	æ: "ae",
	œ: "oe",
	ø: "o",
	ð: "d",
	þ: "th",
	ß: "ss",
	đ: "d",
	ł: "l",
	ħ: "h",
	ı: "i",
	ŋ: "n",
	ŧ: "t",
	ĸ: "k",
};

/**
 * Fold a display string into a key that sorts the way a reader expects, under
 * a plain byte comparison.
 *
 * SQLite compares text with BINARY collation, which orders every uppercase
 * letter before every lowercase one and puts accented letters after `z`:
 * `Adam, Zoe, alice, Álvaro`. Casefolding and reducing Latin letters to their
 * base form gives `adam, alice, alvaro, zoe`, the same order on SQLite and on
 * Postgres — the key is plain ASCII for Latin scripts, so the two collations
 * can't disagree about it.
 *
 * Scripts outside Latin keep their letters and still sort by code point, which
 * groups them by script but doesn't collate them; that needs ICU, which D1
 * doesn't carry. Punctuation is kept, so `O'Brien` files before `Oakley`.
 *
 * Store this next to the display value rather than computing it in a query: an
 * `ORDER BY` and a cursor's seek predicate have to compare the same thing, and
 * neither dialect can produce this key in SQL.
 */
export function sortKey(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(COMBINING_MARK_PATTERN, "")
		.replace(LATIN_EXPANSION_PATTERN, (letter) => LATIN_EXPANSIONS[letter] ?? letter)
		.trim()
		.replace(WHITESPACE_PATTERN, " ");
}
