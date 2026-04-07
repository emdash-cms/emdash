import type { PortableTextBlock } from "emdash";

const WORDS_PER_MINUTE = 200;
const WHITESPACE_REGEX = /\s+/;

export function extractText(blocks: PortableTextBlock[] | undefined): string {
	if (!blocks || !Array.isArray(blocks)) return "";

	return blocks
		.filter(
			(
				block,
			): block is PortableTextBlock & {
				children: Array<{ _type: string; text?: string }>;
			} => block._type === "block" && Array.isArray(block.children),
		)
		.map((block) =>
			block.children
				.filter((child) => child._type === "span" && typeof child.text === "string")
				.map((span) => span.text)
				.join(""),
		)
		.join(" ");
}

export function getReadingTime(content: PortableTextBlock[] | undefined): number {
	const text = extractText(content);
	const wordCount = text.split(WHITESPACE_REGEX).filter(Boolean).length;
	const minutes = Math.ceil(wordCount / WORDS_PER_MINUTE);
	return Math.max(1, minutes);
}
