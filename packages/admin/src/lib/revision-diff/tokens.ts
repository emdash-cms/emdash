export interface Token {
	text: string;
	/** Offset of the token in the tokenized text. */
	start: number;
	/** A word, as opposed to whitespace or punctuation. */
	word: boolean;
}

export type Tokenizer = (text: string) => Token[];

// Combining marks stay with the character they modify.
const CODE_TOKEN = /\s+|[\p{L}\p{N}\p{M}_$]+|[^\s\p{L}\p{N}_$]\p{M}*/gu;
const IDENTIFIER_START = /^[\p{L}\p{N}_$]/u;

const segmenters = new Map<string, Intl.Segmenter>();

/** A word segmenter for `locale`, created once per locale. An invalid tag gets the default locale. */
export function wordSegmenter(locale: string | undefined): Intl.Segmenter {
	const cacheKey = locale ?? "";
	let segmenter = segmenters.get(cacheKey);
	if (!segmenter) {
		segmenter = createWordSegmenter(locale);
		segmenters.set(cacheKey, segmenter);
	}
	return segmenter;
}

function createWordSegmenter(locale: string | undefined): Intl.Segmenter {
	try {
		return new Intl.Segmenter(locale || undefined, { granularity: "word" });
	} catch {
		return new Intl.Segmenter(undefined, { granularity: "word" });
	}
}

/** Splits text into words, whitespace and punctuation; joining the tokens gives the text back. */
export function tokenizeWords(text: string, locale: string | undefined): Token[] {
	const tokens: Token[] = [];
	for (const { segment, index, isWordLike } of wordSegmenter(locale).segment(text)) {
		tokens.push({ text: segment, start: index, word: isWordLike === true });
	}
	return tokens;
}

/** Splits code into identifiers, whitespace runs and single symbols. */
export const tokenizeCode: Tokenizer = (text) =>
	Array.from(text.matchAll(CODE_TOKEN), (match) => ({
		text: match[0],
		start: match.index,
		word: IDENTIFIER_START.test(match[0]),
	}));

/** Treats the whole text as one token, so any change replaces the value as a whole. */
export const tokenizeValue: Tokenizer = (text) => (text ? [{ text, start: 0, word: true }] : []);

/** Lowercased words of `text` with how often each occurs. */
export function wordBag(tokens: readonly Token[], locale: string | undefined): Map<string, number> {
	const lowerCaseLocale = wordSegmenter(locale).resolvedOptions().locale;
	const bag = new Map<string, number>();
	for (const token of tokens) {
		if (!token.word) continue;
		const word = token.text.toLocaleLowerCase(lowerCaseLocale);
		bag.set(word, (bag.get(word) ?? 0) + 1);
	}
	return bag;
}

export function countWords(text: string, locale: string | undefined): number {
	let words = 0;
	for (const token of tokenizeWords(text, locale)) {
		if (token.word) words++;
	}
	return words;
}
