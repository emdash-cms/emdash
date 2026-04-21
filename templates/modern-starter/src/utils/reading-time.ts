export function extractText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const children = (block as { children?: Array<{ text?: string }> }).children;
			if (!Array.isArray(children)) return [];
			return children.map((child) => child?.text ?? "");
		})
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export function getReadingTime(value: unknown, wordsPerMinute = 220): number {
	const text = extractText(value);
	if (!text) return 1;
	return Math.max(1, Math.ceil(text.split(/\s+/).length / wordsPerMinute));
}
