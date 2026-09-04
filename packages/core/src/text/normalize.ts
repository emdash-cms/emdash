/**
 * Shared text-normalization core.
 *
 * Everything here is safe for both the search and the sort pipelines: it
 * unifies representations that mean the same thing without destroying
 * information either pipeline needs. Lossy folds that only one side wants
 * (mark stripping, Latin expansions, recall-oriented Arabic folds) live in
 * `search-key.ts` and `sort-key.ts`, which compose the pieces below.
 *
 * The invariant that makes this module load-bearing: the same normalization
 * must run at FTS index time, at FTS query time, and at sort-key write time.
 * FTS5's `unicode61` tokenizer performs no Unicode normalization of its own,
 * so NFC and NFD spellings of the same word tokenize differently unless the
 * text is normalized before it reaches SQLite.
 */

/** Zero-width non-joiner and joiner -- word separators in Farsi and Hindi. */
const ZERO_WIDTH_RE = /[\u200C\u200D]/g;
/** Remaining format characters: bidi controls, soft hyphen, BOM. */
const FORMAT_RE = /\p{Cf}/gu;
const CONTROL_RE = /\p{Cc}/gu;
/** Arabic tatweel/kashida is a justification glyph, never a letter. */
const TATWEEL_RE = /\u0640/g;
const WHITESPACE_RE = /\s+/gu;
/** Locales whose case folding maps I/İ differently from the invariant rules. */
const TURKIC_LOCALE_RE = /^(tr|az)(-|$)/i;

const HIRAGANA_OFFSET = 0x60;
const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;

/**
 * Code point of the digit zero in each decimal block folded to ASCII.
 *
 * NFKC does not touch these -- Arabic-Indic and Devanagari digits have no
 * compatibility decomposition -- so `٢٨`, `۲۸` and `२८` all need an explicit
 * fold to `28`.
 */
const DIGIT_ZEROS: readonly number[] = [
	0x0660, // Arabic-Indic
	0x06f0, // Extended Arabic-Indic (Farsi, Urdu)
	0x0966, // Devanagari
	0x09e6, // Bengali
	0x0a66, // Gurmukhi
	0x0ae6, // Gujarati
	0x0b66, // Oriya
	0x0be6, // Tamil
	0x0c66, // Telugu
	0x0ce6, // Kannada
	0x0d66, // Malayalam
	0x0e50, // Thai
	0x0ed0, // Lao
	0x0f20, // Tibetan
	0x1040, // Myanmar
	0x17e0, // Khmer
];

/**
 * Combining marks that carry no letter identity and may be removed.
 *
 * Deliberately an allowlist. Stripping every `\p{M}` would delete Devanagari
 * matras and Thai vowel signs, which are letters, not accents -- Hindi and
 * Thai text would be destroyed rather than folded.
 */
const REMOVABLE_MARK_RANGES: readonly (readonly [number, number])[] = [
	[0x0300, 0x036f], // Combining Diacritical Marks (Latin, Greek, Cyrillic)
	[0x0483, 0x0489], // Cyrillic
	[0x0591, 0x05bd], // Hebrew niqqud
	[0x05bf, 0x05c7],
	[0x064b, 0x065f], // Arabic harakat (fatha, damma, kasra, sukun, shadda, tanwin)
	[0x0670, 0x0670], // Arabic superscript alef
	[0x06d6, 0x06dc], // Quranic annotation
	[0x06df, 0x06e8],
	[0x06ea, 0x06ed],
	[0x0711, 0x0711], // Syriac
	[0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
	[0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
	[0x20d0, 0x20f0], // Combining Diacritical Marks for Symbols
	[0xfe20, 0xfe2f], // Combining Half Marks
];

/**
 * Letters that differ only by orthographic or positional convention.
 *
 * Arabic hamza carriers fold to their base letter and the Farsi yeh/keheh
 * fold to their Arabic counterparts, so text keyed in either convention
 * compares equal. Ta marbuta is *not* here: folding it to heh raises search
 * recall but merges distinct names, so it belongs to the search pipeline only.
 *
 * Greek final sigma is a positional spelling of the same letter -- lowercasing
 * `ΟΔΟΣ` yields `ς`, so without this fold it would neither match nor sort with
 * a medial `σ` typed directly.
 */
const LETTER_FOLD: ReadonlyMap<string, string> = new Map([
	["آ", "ا"], // آ alef with madda
	["أ", "ا"], // أ alef with hamza above
	["إ", "ا"], // إ alef with hamza below
	["ٱ", "ا"], // ٱ alef wasla
	["ؤ", "و"], // ؤ waw with hamza
	["ئ", "ي"], // ئ yeh with hamza
	["ى", "ي"], // ى alef maqsura
	["ی", "ي"], // ی Farsi yeh
	["ک", "ك"], // ک keheh
	["ڪ", "ك"], // ڪ swash kaf
	["ۀ", "ه"], // ۀ heh with yeh above
	["ە", "ه"], // ە ae
	["ς", "σ"], // ς Greek final sigma
]);

export interface NormalizeOptions {
	/**
	 * BCP 47 tag. Only affects case folding, and only for Turkic locales,
	 * where `I`/`ı` and `İ`/`i` are distinct letters. Omit for the
	 * locale-invariant fold, which is what search wants so that `İSTANBUL`
	 * and `istanbul` match regardless of the user's locale.
	 */
	locale?: string;
}

function isInRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
	for (const [start, end] of ranges) {
		if (cp >= start && cp <= end) return true;
	}
	return false;
}

function foldDigit(cp: number): number {
	for (const zero of DIGIT_ZEROS) {
		if (cp >= zero && cp <= zero + 9) return 0x30 + (cp - zero);
	}
	return cp;
}

function foldCodePoints(text: string): string {
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;

		if (cp >= KATAKANA_START && cp <= KATAKANA_END) {
			out += String.fromCodePoint(cp - HIRAGANA_OFFSET);
			continue;
		}

		const digit = foldDigit(cp);
		if (digit !== cp) {
			out += String.fromCodePoint(digit);
			continue;
		}

		out += LETTER_FOLD.get(ch) ?? ch;
	}
	return out;
}

/**
 * Apply the normalization both pipelines share.
 *
 * NFKC, invisible-character removal, tatweel removal, Arabic-script and Greek
 * letter unification, katakana-to-hiragana folding, decimal-digit folding to
 * ASCII, case folding, and whitespace collapsing. Combining marks and Latin
 * expansions such as `ß` are left alone -- they are lossy in ways the two
 * pipelines resolve differently.
 */
export function normalizeText(text: string, options: NormalizeOptions = {}): string {
	const locale = options.locale;
	const cased = TURKIC_LOCALE_RE.test(locale ?? "")
		? text.normalize("NFKC").toLocaleLowerCase(locale)
		: text.normalize("NFKC").toLowerCase();

	return foldCodePoints(
		cased
			.replace(ZERO_WIDTH_RE, " ")
			.replace(CONTROL_RE, " ")
			.replace(FORMAT_RE, "")
			.replace(TATWEEL_RE, ""),
	)
		.normalize("NFC")
		.replace(WHITESPACE_RE, " ")
		.trim();
}

/**
 * Remove combining marks that are accents rather than letters.
 *
 * Folds Latin accents, Arabic harakat, Hebrew niqqud and Cyrillic marks;
 * leaves Devanagari matras and Thai vowel signs intact.
 */
export function foldMarks(text: string): string {
	let out = "";
	for (const ch of text.normalize("NFD")) {
		const cp = ch.codePointAt(0) ?? 0;
		if (isInRanges(cp, REMOVABLE_MARK_RANGES)) continue;
		out += ch;
	}
	return out.normalize("NFC");
}

/**
 * Latin letters with no decomposition, expanded to their conventional
 * transliteration so `Straße` and `Strasse` compare equal.
 *
 * Order-destroying for locales that alphabetize these separately, so callers
 * that tailor collation must resolve their tailoring before folding here.
 */
const LATIN_EXPANSIONS: ReadonlyMap<string, string> = new Map([
	["ß", "ss"],
	["æ", "ae"],
	["œ", "oe"],
	["ø", "o"],
	["đ", "d"],
	["ð", "d"],
	["þ", "th"],
	["ł", "l"],
	["ı", "i"],
	["ħ", "h"],
	["ŋ", "n"],
	["ŧ", "t"],
	["ƶ", "z"],
]);

/** Expand Latin letters that carry no combining mark to fold away. */
export function foldLatinExpansions(text: string): string {
	let out = "";
	for (const ch of text) {
		out += LATIN_EXPANSIONS.get(ch) ?? ch;
	}
	return out;
}
