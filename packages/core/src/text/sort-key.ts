import { resolveCollation, type Collation } from "./collation.js";
import { foldLatinExpansions, foldMarks, normalizeText } from "./normalize.js";

/**
 * Deterministic sort keys for alphabetizing text under a binary collation.
 *
 * SQLite -- and therefore D1 -- compares TEXT with BINARY collation, so
 * `ORDER BY display_name` files `Adam, Zoe, alice, Álvaro` in that order.
 * The fix is to store a key alongside the text and order by the key.
 *
 * Two obligations come with that, and both are the caller's:
 *
 * 1. **The key is persisted.** Changing how it is computed invalidates every
 *    stored key, which means a forward-only backfill migration, and during a
 *    rolling deploy old and new code would compare against differently
 *    computed keys. `SORT_KEY_VERSION` exists so that stale keys are
 *    detectable; bump it whenever output changes for any input.
 * 2. **Keys collide by design.** Folding accents means `Alvaro` and `Álvaro`
 *    produce the same key. Every query ordering by a sort key must add a
 *    unique tiebreaker (`id`), and keyset cursors must compare `(key, id)`
 *    with exactly the same semantics as the `ORDER BY` -- otherwise
 *    pagination skips and duplicates rows.
 *
 * Known limitations, all of which need a real collation library to fix:
 * Chinese sorts by code point rather than pinyin, Japanese by kana rather
 * than by reading (which cannot be derived from the text at all), Thai does
 * not apply the leading-vowel reordering rule, and French does not apply the
 * backwards accent comparison for otherwise-equal strings.
 */

/** Bump whenever `sortKey` output changes for any input. */
export const SORT_KEY_VERSION = 1;

/** Default cap on key length, in characters. */
export const SORT_KEY_MAX_LENGTH = 256;

/** Sorts below every letter and digit, so word boundaries order first. */
const SEPARATOR_ELEMENT = "  ";
/** Below `0` and above the separator, so numbers order between the two. */
const NUMERIC_MARKER = "/";
/** Digit-run length is encoded as one base-36 character. */
const MAX_NUMERIC_DIGITS = 35;

const LEADING_ZEROS_RE = /^0+/;
const SEPARATOR_RE = /\s/u;
const IGNORABLE_RE = /[\p{P}\p{S}]/u;

export interface SortKeyOptions {
	/**
	 * BCP 47 tag selecting a collation tailoring. Omit for the invariant
	 * order, which is correct for English, French, German, Dutch, Portuguese
	 * and every locale without a tailoring in `collation.ts`.
	 */
	locale?: string;
	/**
	 * Compare digit runs by value, so `Chapter 2` precedes `Chapter 10`.
	 * Defaults to true.
	 */
	numeric?: boolean;
	/** Cap on the returned key length. Defaults to `SORT_KEY_MAX_LENGTH`. */
	maxLength?: number;
}

function isAsciiDigit(ch: string): boolean {
	return ch >= "0" && ch <= "9";
}

/**
 * Encode a digit run so that binary comparison orders it numerically.
 *
 * Leading zeros are dropped and the significant length is prefixed, so `2`
 * (`/12`) precedes `10` (`/210`). `007` and `7` produce the same element and
 * fall to the caller's tiebreaker.
 */
function numericElement(digits: string): string {
	const trimmed = digits.replace(LEADING_ZEROS_RE, "");
	if (trimmed === "") return `${NUMERIC_MARKER}10`;
	const clamped = trimmed.slice(0, MAX_NUMERIC_DIGITS);
	return NUMERIC_MARKER + clamped.length.toString(36) + clamped;
}

/**
 * A character with its removable marks stripped.
 *
 * ASCII short-circuits: it carries no marks and no expansion, so the common
 * path skips the two `String.normalize` calls inside `foldMarks`.
 */
function baseLetter(ch: string): string {
	return (ch.codePointAt(0) ?? 0) < 0x80 ? ch : foldMarks(ch);
}

/**
 * Elements for a character with no tailoring: bucket its base letter under
 * slot `0`. Punctuation is dropped so `O'Brien` files with `OBrien`;
 * whitespace becomes a separator so `de la Cruz` keeps its word boundaries.
 */
function defaultElements(base: string): string {
	let out = "";
	for (const folded of foldLatinExpansions(base)) {
		if (SEPARATOR_RE.test(folded)) {
			out += SEPARATOR_ELEMENT;
			continue;
		}
		if (IGNORABLE_RE.test(folded)) continue;
		out += `${folded}0`;
	}
	return out;
}

/**
 * Build a sort key whose binary comparison reproduces alphabetical order.
 *
 * Returns `""` for input with no sortable characters. An empty key is a
 * legitimate value that sorts first -- unlike the search pipeline, there is
 * no fallback path to take.
 */
export function sortKey(text: string, options: SortKeyOptions = {}): string {
	const { locale, numeric = true, maxLength = SORT_KEY_MAX_LENGTH } = options;

	// oxlint-disable-next-line typescript/no-misused-spread -- collation elements are per code point
	const chars = [...normalizeText(text, { locale })];
	const collation = resolveCollation(locale);

	let key = "";
	let index = 0;

	const append = (element: string): boolean => {
		if (element === SEPARATOR_ELEMENT && (key === "" || key.endsWith(SEPARATOR_ELEMENT))) {
			return true;
		}
		if (key.length + element.length > maxLength) return false;
		key += element;
		return true;
	};

	while (index < chars.length) {
		const ch = chars[index] ?? "";

		if (numeric && isAsciiDigit(ch)) {
			let end = index;
			while (end < chars.length && isAsciiDigit(chars[end] ?? "")) end++;
			if (!append(numericElement(chars.slice(index, end).join("")))) break;
			index = end;
			continue;
		}

		const base = baseLetter(ch);
		const tailored = collation ? matchTailoring(chars, index, base, collation) : undefined;
		if (tailored) {
			if (!append(tailored.element)) break;
			index += tailored.length;
			continue;
		}

		// A single character can fold to several elements ("ß" to "s0s0"),
		// so it is all-or-nothing against the length cap.
		if (!append(defaultElements(base))) break;
		index++;
	}

	return key.endsWith(SEPARATOR_ELEMENT) ? key.slice(0, -SEPARATOR_ELEMENT.length) : key;
}

function matchTailoring(
	chars: readonly string[],
	index: number,
	base: string,
	collation: Collation,
): { element: string; length: number } | undefined {
	const longest = Math.min(collation.maxSequenceLength, chars.length - index);
	for (let length = longest; length >= 1; length--) {
		const element = collation.elements.get(chars.slice(index, index + length).join(""));
		if (element !== undefined) return { element, length };
	}

	// A tailoring that renumbers a base letter -- Turkish moves i to slot 1 so
	// dotless ı can hold slot 0 -- has to claim that letter's accented forms
	// too, or they fold through to the slot the other letter now occupies.
	if (base === chars[index]) return undefined;
	const element = collation.elements.get(base);
	return element === undefined ? undefined : { element, length: 1 };
}
