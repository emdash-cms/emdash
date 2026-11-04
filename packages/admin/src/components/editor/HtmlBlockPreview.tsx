/**
 * Preview tab of the HTML block: the block in the same document the site
 * renders, in a sandbox that can run scripts but can't reach the admin.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Play } from "@phosphor-icons/react";
import DOMPurify from "dompurify";
import * as React from "react";

import {
	HTML_BLOCK_FRAME_MAX_HEIGHT,
	HTML_BLOCK_FRAME_MESSAGE,
	SITE_HTML_ALLOWED_ATTRIBUTES,
	SITE_HTML_ALLOWED_SCHEMES,
	SITE_HTML_ALLOWED_TAGS,
	SITE_HTML_IFRAME_HOSTS,
	buildHtmlBlockFrame,
} from "../../html-block";
import { cn } from "../../lib/utils";
import { useDocumentDragging } from "./EmbedBlockShell";

// Decides only whether a saved block waits for a click before it runs; the
// sandbox is the security boundary. Frames count because their documents can
// carry scripts too.
const RUNS_SCRIPT_RE =
	/<script\b|<(?:i?frame|object|embed)\b|[\s/"']on[a-z]+\s*=|\ssrcdoc\s*=|http-equiv/i;

const URL_ATTRIBUTES = new Set(["href", "src", "cite"]);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

let purifier: ReturnType<typeof DOMPurify> | undefined;

/**
 * Remove what the site's sanitizer (sanitize-html) removes, so the inline
 * preview shows what the site renders: disallowed tags keep their text,
 * attributes are allowed per tag, and iframes on other hosts lose their `src`.
 */
function cleanInlineHtml(html: string): string {
	if (!purifier) {
		// A private instance, so this hook doesn't change other sanitizers.
		purifier = DOMPurify(window);
		purifier.addHook("afterSanitizeAttributes", (node) => {
			const tag = node.nodeName.toLowerCase();
			const allowed = new Set([
				...(SITE_HTML_ALLOWED_ATTRIBUTES["*"] ?? []),
				...(SITE_HTML_ALLOWED_ATTRIBUTES[tag] ?? []),
			]);
			for (const name of node.getAttributeNames()) {
				const scheme = URL_ATTRIBUTES.has(name)
					? SCHEME_RE.exec(node.getAttribute(name)?.trim() ?? "")?.[1]?.toLowerCase()
					: undefined;
				const permitted = allowed.has(name) || (name.startsWith("data-") && allowed.has("data-*"));
				if (!permitted || (scheme && !SITE_HTML_ALLOWED_SCHEMES.includes(scheme))) {
					node.removeAttribute(name);
				}
			}
			if (tag !== "iframe") return;
			const src = node.getAttribute("src") ?? "";
			const base = "https://invalid.invalid";
			if (
				!URL.canParse(src, base) ||
				!SITE_HTML_IFRAME_HOSTS.includes(new URL(src, base).hostname)
			) {
				node.removeAttribute("src");
			}
		});
	}
	return purifier.sanitize(html, {
		ALLOWED_TAGS: [...SITE_HTML_ALLOWED_TAGS],
		ALLOWED_ATTR: Object.values(SITE_HTML_ALLOWED_ATTRIBUTES)
			.flat()
			.filter((name) => name !== "data-*"),
		ALLOW_DATA_ATTR: true,
		FORBID_CONTENTS: ["script", "style", "textarea", "option"],
	});
}

export interface HtmlBlockPreviewProps {
	html: string;
	css: string;
	js: string;
	isolated: boolean;
	/** False until Run preview or an edit, for saved blocks that run scripts. */
	allowScripts: boolean;
	onRun: () => void;
	/** The last height the frame reported, kept across tab changes. */
	lastHeight: React.RefObject<number>;
}

export function HtmlBlockPreview({
	html,
	css,
	js,
	isolated,
	allowScripts,
	onRun,
	lastHeight,
}: HtmlBlockPreviewProps) {
	const { t } = useLingui();
	const source = isolated ? { html, css, js } : { html: cleanInlineHtml(html) };
	const srcdoc = buildHtmlBlockFrame(source);
	const empty = !source.html.trim() && !(isolated && (css.trim() || js.trim()));
	const waiting = isolated && !allowScripts && (js.trim() !== "" || RUNS_SCRIPT_RE.test(html));

	return (
		<div className="space-y-2 p-3">
			{empty ? (
				<p className="py-6 text-center text-sm text-kumo-subtle">{t`Nothing to preview yet.`}</p>
			) : waiting ? (
				<div className="flex flex-col items-center gap-3 py-6 text-sm text-kumo-subtle">
					{t`This block runs JavaScript.`}
					<Button
						type="button"
						size="sm"
						icon={<Play className="size-4" aria-hidden="true" />}
						onClick={onRun}
					>
						{t`Run preview`}
					</Button>
				</div>
			) : (
				<PreviewFrame key={srcdoc} srcdoc={srcdoc} lastHeight={lastHeight} />
			)}
			{!isolated && (
				<p className="text-xs text-kumo-subtle">
					{t`Inline blocks use your site's styles. Your site removes scripts, style tags and style attributes, and empties iframes other than YouTube and Vimeo.`}
				</p>
			)}
		</div>
	);
}

function PreviewFrame({
	srcdoc,
	lastHeight,
}: {
	srcdoc: string;
	lastHeight: React.RefObject<number>;
}) {
	const { t } = useLingui();
	const [blocked, setBlocked] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const frameRef = React.useRef<HTMLIFrameElement>(null);
	const [visible, setVisible] = React.useState(false);
	const [height, setHeight] = React.useState(lastHeight.current);
	const dragging = useDocumentDragging();

	// Posts with many HTML blocks don't create every frame at load.
	React.useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				setVisible(true);
				observer.disconnect();
			},
			{ rootMargin: "200px" },
		);
		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	// Registered before the frame's document loads, so its first report arrives.
	React.useLayoutEffect(() => {
		if (!visible) return;
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frameRef.current?.contentWindow) return;
			const data: unknown = event.data;
			if (typeof data !== "object" || data === null) return;
			if (!("type" in data) || data.type !== HTML_BLOCK_FRAME_MESSAGE) return;
			if ("blocked" in data && data.blocked === true) setBlocked(true);
			if ("height" in data && typeof data.height === "number" && Number.isFinite(data.height)) {
				const next = Math.min(Math.max(data.height, 0), HTML_BLOCK_FRAME_MAX_HEIGHT);
				lastHeight.current = next;
				setHeight(next);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [visible, lastHeight]);

	return (
		<>
			<div ref={containerRef} style={{ height }}>
				{visible && (
					<iframe
						ref={frameRef}
						srcDoc={srcdoc}
						sandbox="allow-scripts"
						title={t`HTML block preview`}
						style={{ height: "100%" }}
						className={cn("block w-full border-0", dragging && "pointer-events-none")}
					/>
				)}
			</div>
			{blocked && (
				<p className="text-xs text-kumo-subtle">
					{t`The admin's security policy blocked some resources this block loads, such as external scripts, fonts or frames. Your site may still load them.`}
				</p>
			)}
		</>
	);
}
