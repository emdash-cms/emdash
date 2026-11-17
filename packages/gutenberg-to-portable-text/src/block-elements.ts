/**
 * A block-level element of classic-editor HTML: a block tag with its content up
 * to the first end tag of the same name, a `<hr>` or `<br>`, or an `<img>`.
 */
export interface BlockElement {
	/** Offset of the element's start tag */
	index: number;
	/** The element's HTML */
	html: string;
	/** The tag name as written; empty for an image */
	tag: string;
	/** The HTML between the start and end tags; empty for `hr`, `br` and `img` */
	content: string;
}

/** Tags with content that are tried after `p` and `h1`–`h6`, in this order */
const CONTENT_TAGS = ["blockquote", "pre", "ul", "ol", "figure", "div", "hr"];
const LINE_TAG_PATTERN = /<(hr|br)\s*\/?>/uy;
/** What may follow a block tag's name: whitespace, `/` or `>` */
const TAG_NAME_END_PATTERN = /^[\s/>]$/u;
// Attributes are read as whole quoted values or single characters, and no part spans a `<`.
const IMAGE_TAG_PATTERN = /<img\s(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/uy;

/**
 * Scan classic-editor HTML for block-level elements as the pattern
 * `<(p|h[1-6]|blockquote|pre|ul|ol|figure|div|hr)(?=[\s/>])[^>]*>([\s\S]*?)<\/\1>|<(hr|br)\s*\/?>|<img…>`
 * matches them: at each `<`, the first tag name in that order that ends at
 * whitespace, `/` or `>`, whose start tag ends at the next `>` and has an end
 * tag after it; then `<hr>` or `<br>`; then an image.
 *
 * Each search for `>` or an end tag reuses the last one for the same text, so
 * HTML with many unclosed tags takes linear time, where the pattern took
 * quadratic time. Each call must start at or after the previous one.
 */
export function createBlockScanner(html: string): (from: number) => BlockElement | null {
	const searches = new Map<string, { from: number; at: number }>();
	const indexOf = (text: string, from: number): number => {
		const last = searches.get(text);
		if (last && last.from <= from && (last.at === -1 || last.at >= from)) return last.at;
		const at = html.indexOf(text, from);
		searches.set(text, { from, at });
		return at;
	};

	const tagsAt = (index: number): string[] => {
		const named = (tag: string) =>
			html.startsWith(tag, index + 1) &&
			TAG_NAME_END_PATTERN.test(html[index + 1 + tag.length] ?? "");
		const tags: string[] = [];
		if (named("p")) tags.push("p");
		const level = html[index + 2];
		if (level && level >= "1" && level <= "6" && named(`h${level}`)) tags.push(`h${level}`);
		for (const tag of CONTENT_TAGS) {
			if (named(tag)) tags.push(tag);
		}
		return tags;
	};

	const contentElementAt = (index: number): BlockElement | null => {
		const tags = tagsAt(index);
		if (tags.length === 0) return null;
		const open = indexOf(">", index + 1);
		if (open === -1) return null;
		for (const tag of tags) {
			const close = indexOf(`</${tag}>`, open + 1);
			if (close !== -1) {
				return {
					index,
					html: html.slice(index, close + tag.length + 3),
					tag,
					content: html.slice(open + 1, close),
				};
			}
		}
		return null;
	};

	const stickyElementAt = (pattern: RegExp, index: number): BlockElement | null => {
		pattern.lastIndex = index;
		const match = pattern.exec(html);
		return match ? { index, html: match[0], tag: match[1] ?? "", content: "" } : null;
	};

	return (from) => {
		for (let index = html.indexOf("<", from); index !== -1; index = html.indexOf("<", index + 1)) {
			const element =
				contentElementAt(index) ??
				stickyElementAt(LINE_TAG_PATTERN, index) ??
				stickyElementAt(IMAGE_TAG_PATTERN, index);
			if (element) return element;
		}
		return null;
	};
}
