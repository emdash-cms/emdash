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

const BASE_STYLE = "body{margin:0;font-family:system-ui,sans-serif;line-height:1.5}";

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
// `</script>` from ending it.
const SCRIPT_TAG_RE = /<(?=\/?script)/gi;

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
		`<!doctype html><html><head><meta charset="utf-8"><base target="_top">` +
		`<style>${BASE_STYLE}</style><script>${FRAME_SCRIPT}</script>${style}</head>` +
		`<body>${html}${script}</body></html>`
	);
}
