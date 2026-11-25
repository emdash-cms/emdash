/**
 * HTML block fields and the document an isolated HTML block renders in.
 *
 * Server-safe: the site renderer, the core converters and the admin editor
 * all import this module, so isolated blocks look the same everywhere.
 */

export const HTML_BLOCK_FRAME_MESSAGE = "emdash:html-block-frame";

/** Frames sized to the viewport grow with every height report; past this they scroll. */
export const HTML_BLOCK_FRAME_MAX_HEIGHT = 20_000;

/** Never add `allow-same-origin`: it would give author scripts the site's origin. */
export const HTML_BLOCK_FRAME_SANDBOX =
	"allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation";

export interface HtmlBlockFields {
	html: string;
	css?: string;
	js?: string;
	isolated?: boolean;
}

/**
 * Read an HTML block's fields, keeping `css` and `js` only when non-empty and
 * `isolated` only when true, so blocks saved before these fields existed
 * round-trip to identical JSON.
 */
export function htmlBlockFields(source: object): HtmlBlockFields {
	const {
		html,
		css,
		js,
		isolated,
	}: { html?: unknown; css?: unknown; js?: unknown; isolated?: unknown } = source;
	const fields: HtmlBlockFields = { html: typeof html === "string" ? html : "" };
	if (typeof css === "string" && css) fields.css = css;
	if (typeof js === "string" && js) fields.js = js;
	if (isolated === true) fields.isolated = true;
	return fields;
}

/**
 * What the site's sanitizer keeps in inline HTML blocks: sanitize-html's
 * default tags plus `img`, `span` and `iframe`. Changing it changes how
 * existing inline blocks render. The admin's inline preview removes the same
 * things, so it shows what the site renders.
 */
export const SITE_HTML_ALLOWED_TAGS: readonly string[] = [
	"address",
	"article",
	"aside",
	"footer",
	"header",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hgroup",
	"main",
	"nav",
	"section",
	"blockquote",
	"dd",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"hr",
	"li",
	"menu",
	"ol",
	"p",
	"pre",
	"ul",
	"a",
	"abbr",
	"b",
	"bdi",
	"bdo",
	"br",
	"cite",
	"code",
	"data",
	"dfn",
	"em",
	"i",
	"kbd",
	"mark",
	"q",
	"rb",
	"rp",
	"rt",
	"rtc",
	"ruby",
	"s",
	"samp",
	"small",
	"span",
	"strong",
	"sub",
	"sup",
	"time",
	"u",
	"var",
	"wbr",
	"caption",
	"col",
	"colgroup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"img",
	"iframe",
];

export const SITE_HTML_ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
	"*": ["class", "id", "data-*"],
	a: ["href", "name", "target"],
	img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
	iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen"],
};

/** URL schemes allowed in `href`, `src` and `cite`. Relative URLs are always allowed. */
export const SITE_HTML_ALLOWED_SCHEMES: readonly string[] = [
	"http",
	"https",
	"ftp",
	"mailto",
	"tel",
];

/** Hosts whose iframes keep their `src`; other iframes lose it. */
export const SITE_HTML_IFRAME_HOSTS: readonly string[] = ["www.youtube.com", "player.vimeo.com"];

const BASE_STYLE = "body{margin:0;font-family:system-ui,sans-serif;line-height:1.5}";

// Without a base, the frame's base URL would be the page's full URL, query and
// fragment included, and the author's JavaScript could read it. The author's
// script can remove a base from its own document, which then falls back to the
// base URL of the document around it, so that document is a shell holding only
// this base, and the author's document is a frame inside it.
const BASE = '<base href="/" target="_top">';

const SHELL_STYLE =
	"html,body{height:100%;margin:0}iframe{display:block;width:100%;height:100%;border:0}";

// A policy such as `base-uri 'none'` rejects the base, and the shell would then
// fall back to the page's full URL, so the shell stops before it parses the
// author's frame. The page can only reach the shell's window, so the shell
// passes messages between the page and the author's frame in both directions.
const SHELL_SCRIPT = `if (document.baseURI !== new URL("/", document.baseURI).href) stop();
addEventListener("message", (event) => {
	const inner = frames[0];
	if (event.source === inner) parent.postMessage(event.data, "*", [...event.ports]);
	else if (event.source === parent) inner?.postMessage(event.data, "*", [...event.ports]);
});`;

// Runs before the author's markup so an unclosed comment or tag can't swallow it.
// The parent can ask for a height report by posting the message type to the frame.
// A root pinned to the viewport (`html { height: 100% }`) only shows its real height
// as overflow, and a horizontal scrollbar takes its height from the viewport.
const FRAME_SCRIPT = `(() => {
	const type = ${JSON.stringify(HTML_BLOCK_FRAME_MESSAGE)};
	const root = document.documentElement;
	const report = () => {
		const overflow = root.scrollHeight > root.clientHeight ? root.scrollHeight : 0;
		const height = Math.max(root.getBoundingClientRect().height, overflow);
		parent.postMessage({ type, height: Math.ceil(height + innerHeight - root.clientHeight) }, "*");
	};
	const observer = new ResizeObserver(report);
	observer.observe(root);
	addEventListener("DOMContentLoaded", () => observer.observe(document.body));
	addEventListener("message", (event) => {
		if (event.source === parent && event.data?.type === type) report();
	});
	addEventListener(
		"securitypolicyviolation",
		() => parent.postMessage({ type, blocked: true }, "*"),
		{ once: true },
	);
})();`;

const STYLE_END_RE = /<\/(style)/gi;
// `</script` would end the element early, and `<script` after `<!--` would stop the real
// `</script>` from ending it. Either needs whitespace, `/` or `>` after the name, so code
// such as `i<scripts.length` is left alone.
const SCRIPT_TAG_RE = /<(?=\/?script[\t\n\f\r />])/gi;
const ATTRIBUTE_RE = /[&"<>]/g;
const ENTITIES: Record<string, string> = { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" };

function escapeAttribute(value: string): string {
	return value.replace(ATTRIBUTE_RE, (char) => ENTITIES[char] ?? char);
}

/**
 * The document for an isolated HTML block's frame. The block's own document is
 * a sandboxed frame inside it, titled `title`, which should match the outer
 * frame's title.
 */
export function buildHtmlBlockFrame({
	html,
	css = "",
	js = "",
	title = "",
}: {
	html: string;
	css?: string;
	js?: string;
	title?: string;
}): string {
	const style = css.trim() ? `<style>${css.replace(STYLE_END_RE, "<\\/$1")}</style>` : "";
	const script = js.trim() ? `<script>${js.replace(SCRIPT_TAG_RE, "\\x3c")}</script>` : "";
	const content =
		`<!doctype html><html><head><meta charset="utf-8">${BASE}` +
		`<style>${BASE_STYLE}</style><script>${FRAME_SCRIPT}</script>${style}</head>` +
		`<body>${html}${script}</body></html>`;
	// A content security policy can block the shell's style, so attributes also set
	// the inner frame's width, border and alignment and the shell's margins.
	return (
		`<!doctype html><html><head><meta charset="utf-8">${BASE}` +
		`<style>${SHELL_STYLE}</style><script>${SHELL_SCRIPT}</script></head>` +
		`<body marginwidth="0" marginheight="0"><iframe sandbox="${HTML_BLOCK_FRAME_SANDBOX}" ` +
		`title="${escapeAttribute(title)}" width="100%" frameborder="0" align="top" ` +
		`srcdoc="${escapeAttribute(content)}"></iframe></body></html>`
	);
}
