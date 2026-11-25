import DOMPurify from "dompurify";
import { Marked, Renderer } from "marked";

import { SAFE_URL_RE } from "./url.js";

const HTML_ESCAPE_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

const HTML_ESCAPE_RE = /[&<>"']/g;

function escapeHtml(str: string): string {
	return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]!);
}

const renderer = new Renderer();

renderer.link = function (this: Renderer, { href, tokens }) {
	// `tokens` is the parsed inline content (e.g. `**bold**` → `<strong>`); the
	// token's `text` would be the raw markdown source. DOMPurify re-sanitizes
	// the whole output, so emitting inline HTML here is safe.
	const inner = this.parser.parseInline(tokens);
	if (!SAFE_URL_RE.test(href)) return inner;
	return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
};

renderer.image = ({ text }) => escapeHtml(text);

renderer.html = () => "";

// After an inline `<pre>`, `<code>`, `<kbd>` or `<script>` tag, marked flags the
// following text tokens as already escaped and emits them verbatim. That tag is
// dropped above, so no text here is raw HTML.
const renderText = Renderer.prototype.text;
renderer.text = function (this: Renderer, token) {
	return renderText.call(this, { ...token, escaped: false });
};

const md = new Marked({ renderer, async: false });

/** Allowed tags and attributes for DOMPurify — only standard markdown output. */
const SANITIZE_CONFIG = {
	ALLOWED_TAGS: [
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"p",
		"a",
		"ul",
		"ol",
		"li",
		"blockquote",
		"pre",
		"code",
		"em",
		"strong",
		"del",
		"br",
		"hr",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
		"details",
		"summary",
		"sup",
		"sub",
	],
	ALLOWED_ATTR: ["href", "target", "rel"],
	ALLOW_DATA_ATTR: false,
	ALLOW_ARIA_ATTR: false,
};

let purifier: ReturnType<typeof DOMPurify> | undefined;

function getPurifier() {
	if (!purifier) {
		// A private instance, so this hook doesn't affect other DOMPurify callers.
		purifier = DOMPurify(window);
		purifier.addHook("afterSanitizeAttributes", (node) => {
			if (node.nodeName.toLowerCase() !== "a") return;
			if (SAFE_URL_RE.test(node.getAttribute("href") ?? "")) {
				node.setAttribute("target", "_blank");
				node.setAttribute("rel", "noopener noreferrer");
			} else {
				node.removeAttribute("href");
				node.removeAttribute("target");
				node.removeAttribute("rel");
			}
		});
	}
	return purifier;
}

/**
 * Render untrusted Markdown to a sanitized HTML string safe for
 * `dangerouslySetInnerHTML`.
 *
 * Defense in depth: the `marked` renderer drops raw HTML, drops images, and
 * emits only `https?:` links (escaped, with `rel="noopener noreferrer"`);
 * DOMPurify then re-sanitizes the output against a tag/attribute allowlist
 * (no `script`/`style`/`img`/`iframe`, no inline styles or event handlers)
 * and applies the same link policy to any `<a>` that reaches it.
 */
export function renderMarkdown(markdown: string): string {
	const result = md.parse(markdown);
	const html = typeof result === "string" ? result : "";
	return getPurifier().sanitize(html, SANITIZE_CONFIG);
}
