const PARAGRAPH_BREAK = /\n\s*\n/;

/** Splits plain text into paragraphs at blank lines, dropping empty ones. */
export function toParagraphs(text: string | null | undefined): string[] {
	return (text ?? "")
		.split(PARAGRAPH_BREAK)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
}
