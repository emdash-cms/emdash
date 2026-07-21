import type { PortableTextBlock } from "emdash";

const WORDS_PER_MINUTE = 200;
const CJK_CHARACTERS_PER_MINUTE = 500;
const WHITESPACE_REGEX = /\s+/;
const CJK_CHARACTER_REGEX =
	/\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/gu;

type PortableTextSpan = {
	_type: string;
	text?: string;
};

type PortableTextTextBlock = PortableTextBlock & {
	_type: "block";
	children: PortableTextSpan[];
};

function isTextBlock(block: PortableTextBlock): block is PortableTextTextBlock {
	return block._type === "block" && Array.isArray(block.children);
}

function countWords(text: string): number {
	return text.split(WHITESPACE_REGEX).filter(Boolean).length;
}

function countCjkCharacters(text: string): number {
	return text.match(CJK_CHARACTER_REGEX)?.length ?? 0;
}

/**
 * Extract plain text from Portable Text blocks
 */
export function extractText(blocks: PortableTextBlock[] | undefined): string {
	if (!blocks || !Array.isArray(blocks)) return "";

	return blocks
		.filter(isTextBlock)
		.map((block) =>
			block.children
				.filter((child) => child._type === "span" && typeof child.text === "string")
				.map((span) => span.text)
				.join(""),
		)
		.join(" ");
}

/**
 * Calculate reading time in minutes from Portable Text content
 */
export function getReadingTime(content: PortableTextBlock[] | undefined): number {
	const text = extractText(content);
	const cjkCharacterCount = countCjkCharacters(text);
	const wordCount = countWords(text.replace(CJK_CHARACTER_REGEX, " "));
	const minutes = Math.ceil(
		wordCount / WORDS_PER_MINUTE + cjkCharacterCount / CJK_CHARACTERS_PER_MINUTE,
	);
	return Math.max(1, minutes);
}

/**
 * Format reading time for display
 */
export function formatReadingTime(minutes: number): string {
	return `${minutes} min read`;
}
