const DOCUMENT_START_RE = /^\s*<(?:!doctype|html)\b/i;

/**
 * Insert HTML before the page's closing `</body>`, or return `undefined` when
 * the page isn't a whole document with one.
 */
export function insertBeforeBodyEnd(page: string, html: string): string | undefined {
	// The page's own closing tag is its last `</body>`. Astro leaves `<` and `>`
	// unescaped in attribute values, so an earlier one, or one in a fragment
	// such as a server island, can be author text inside an attribute.
	const bodyEnd = DOCUMENT_START_RE.test(page) ? page.lastIndexOf("</body>") : -1;
	if (bodyEnd === -1) return undefined;
	return page.slice(0, bodyEnd) + html + page.slice(bodyEnd);
}
