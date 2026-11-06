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
// fragment included, and the author's JavaScript could read it.
const BASE = '<base href="/" target="_top">';

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

export function buildHtmlBlockFrame({
	html,
	css = "",
	js = "",
}: {
	html: string;
	css?: string;
	js?: string;
}): string {
	const style = css.trim() ? `<style>${css.replace(STYLE_END_RE, "<\\/$1")}</style>` : "";
	const script = js.trim() ? `<script>${js.replace(SCRIPT_TAG_RE, "\\x3c")}</script>` : "";
	return (
		`<!doctype html><html><head><meta charset="utf-8">${BASE}` +
		`<style>${BASE_STYLE}</style><script>${FRAME_SCRIPT}</script>${style}</head>` +
		`<body>${html}${script}</body></html>`
	);
}
