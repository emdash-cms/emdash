/**
 * Iframe block node for the admin editor.
 *
 * A Code tab that takes an embed code or a link, and a Preview tab that shows
 * the page as the site renders it. Round-trips through Portable Text as
 * `{ _type: "iframe", _key, src, title?, width?, height?, allow?, allowFullscreen? }`.
 */

import { Button } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Code, Eye, Play } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import {
	CLIPBOARD_TOKEN,
	EmbedBlockCard,
	EmbedCodeEditor,
	embedBlockKeyboardShortcuts,
	embedBlockNodeView,
	useDocumentDragging,
	useEmbedBlockFocus,
	type EmbedBlockTab,
} from "./EmbedBlockShell";
import {
	httpsUrl,
	iframeAllow,
	iframeEmbedAttrs,
	iframeEmbedFromAttrs,
	iframeEmbedToCode,
	parseIframeInput,
	type IframeEmbed,
} from "./iframe-embed";

const TABS: readonly EmbedBlockTab[] = [
	{ value: "code", label: msg`Code`, Icon: Code },
	{ value: "preview", label: msg`Preview`, Icon: Eye },
];

const REASONS: Record<"no-iframe" | "not-https", MessageDescriptor> = {
	"no-iframe": msg`No iframe found in this code. For an embed that runs a script, use an HTML block.`,
	"not-https": msg`Only https links can be embedded.`,
};

const PARSE_DELAY_MS = 250;

const SANDBOX = [
	"allow-scripts",
	"allow-same-origin",
	"allow-forms",
	"allow-popups",
	"allow-popups-to-escape-sandbox",
	"allow-presentation",
];

const isEmpty = (attrs: Record<string, unknown>) => !iframeEmbedFromAttrs(attrs).src;

function IframePreview({ embed, url }: { embed: IframeEmbed; url: URL }) {
	const { t } = useLingui();
	const containerRef = React.useRef<HTMLDivElement>(null);
	const [visible, setVisible] = React.useState(false);
	const dragging = useDocumentDragging();

	// Posts with many embeds don't load every page at once.
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

	// As on the site, a page on the admin's own origin gets no same-origin access.
	const sandbox = SANDBOX.filter(
		(token) => token !== "allow-same-origin" || url.host !== window.location.host,
	);
	const size: React.CSSProperties =
		embed.width && embed.height
			? { aspectRatio: `${embed.width} / ${embed.height}` }
			: embed.height
				? { height: embed.height }
				: { aspectRatio: "16 / 9" };

	return (
		<div ref={containerRef} style={size}>
			{visible && (
				<iframe
					src={url.href}
					title={embed.title || t`Embedded content`}
					sandbox={sandbox.join(" ")}
					allow={iframeAllow(embed.allow) || undefined}
					allowFullScreen={embed.allowFullscreen === true}
					// Players such as YouTube's refuse to play without a referrer.
					referrerPolicy="strict-origin-when-cross-origin"
					style={{ height: "100%" }}
					className={cn("block w-full border-0", dragging && "pointer-events-none")}
				/>
			)}
		</div>
	);
}

function IframeBlockNodeView({ editor, node, getPos, updateAttributes }: NodeViewProps) {
	const { t } = useLingui();
	const editable = editor.isEditable;
	const embed = iframeEmbedFromAttrs(node.attrs);
	const code = embed.src ? iframeEmbedToCode(embed) : "";
	// Blocks from the API or clipboard skip the Code tab's checks.
	const url = httpsUrl(embed.src);
	// A frame reads its permissions only when it loads, so changing them reloads it.
	const previewKey = `${url?.href} ${iframeAllow(embed.allow)} ${embed.allowFullscreen === true}`;
	const errorId = React.useId();

	const [tab, setTab] = React.useState(() => (embed.src ? "preview" : "code"));
	// As with HTML blocks, a saved block waits for Load preview before the admin
	// loads someone else's page. Addresses written here load right away.
	const [loadable, setLoadable] = React.useState<string | null>(null);
	const [revision, setRevision] = React.useState(0);
	const [error, setError] = React.useState<keyof typeof REASONS | null>(null);
	const pending = React.useRef<string | null>(null);
	const typed = React.useRef<string | null>(null);
	const valid = React.useRef(true);
	const known = React.useRef(code);
	const timer = React.useRef<number | undefined>(undefined);

	// Parse what was typed: valid input is written, blank input clears the
	// embed, and invalid input writes nothing and shows why.
	const flush = React.useCallback((): boolean => {
		window.clearTimeout(timer.current);
		const text = pending.current;
		if (text === null) return false;
		const result = parseIframeInput(text);
		valid.current = result.ok;
		if (!result.ok) {
			pending.current = null;
			setError(result.reason);
			return false;
		}
		setError(null);
		// Input that can't be written now waits for the next flush.
		if (editor.isDestroyed || !editor.isEditable || typeof getPos() !== "number") return false;
		pending.current = null;
		known.current = result.embed ? iframeEmbedToCode(result.embed) : "";
		updateAttributes(iframeEmbedAttrs(result.embed));
		setLoadable(result.embed?.src ?? null);
		return true;
	}, [editor, getPos, updateAttributes]);

	const focus = useEmbedBlockFocus({ editor, getPos, flush, isEmpty });

	// Undo, redo and other tools change the attributes directly. Show their
	// code and drop the text waiting to be parsed.
	React.useEffect(() => {
		if (code === known.current) return;
		known.current = code;
		pending.current = null;
		typed.current = null;
		setError(null);
		setRevision((current) => current + 1);
	}, [code]);

	const handleChange = (value: string) => {
		pending.current = value;
		typed.current = value;
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(flush, PARSE_DELAY_MS);
	};

	// On blur, valid text is replaced with the canonical embed code, so the Code
	// tab shows what is saved.
	const handleFocusChange = (focused: boolean) => {
		focus.onFocusChange(focused);
		if (focused) return;
		// Runs after the blur's own flush. Leaving the window keeps the text and caret.
		queueMicrotask(() => {
			// Text still waiting to be written stays until it is.
			if (!document.hasFocus() || !valid.current || pending.current !== null) return;
			if (typed.current === null || typed.current === known.current) return;
			typed.current = null;
			setRevision((current) => current + 1);
		});
	};

	// Rejected text isn't kept, so neither is its error.
	const handleTabChange = (value: string) => {
		flush();
		typed.current = null;
		setError(null);
		setTab(value);
	};

	return (
		<EmbedBlockCard
			className="iframe-block"
			editable={editable}
			tabs={TABS}
			activeTab={tab}
			onTabChange={handleTabChange}
			menuLabel={t`Iframe block options`}
			onDelete={focus.deleteBlock}
			focus={focus}
		>
			{tab === "preview" ? (
				url && loadable === embed.src ? (
					<IframePreview key={previewKey} embed={embed} url={url} />
				) : url ? (
					<div className="flex flex-col items-center gap-3 py-6 text-sm text-kumo-subtle">
						{t`This block embeds a page from ${url.host}.`}
						<Button
							type="button"
							size="sm"
							icon={<Play className="size-4" aria-hidden="true" />}
							onClick={() => {
								setLoadable(embed.src);
								focus.panelRef.current?.focus();
							}}
						>
							{t`Load preview`}
						</Button>
					</div>
				) : (
					<p className="py-6 text-center text-sm text-kumo-subtle">{t`Nothing to preview yet.`}</p>
				)
			) : (
				<>
					<EmbedCodeEditor
						key={revision}
						language="html"
						value={code}
						onChange={handleChange}
						onFocusChange={handleFocusChange}
						onEscape={focus.onEscape}
						editable={editable}
						autoFocus={focus.autoFocus}
						ariaLabel={t`Embed code`}
						placeholder={t`Paste an embed code or an https link…`}
						describedBy={errorId}
					/>
					<div id={errorId} aria-live="polite" className="px-3 text-xs text-kumo-danger">
						{error && <p className="py-2">{t(REASONS[error])}</p>}
					</div>
				</>
			)}
		</EmbedBlockCard>
	);
}

// Iframes pasted from other pages arrive empty, so a page can't put its own embed on the site.
const copiedHere = (element: HTMLElement) =>
	element.getAttribute("data-iframe-token") === CLIPBOARD_TOKEN;

function textAttribute(name: string) {
	return {
		default: "",
		parseHTML: (element: HTMLElement) =>
			(copiedHere(element) && element.getAttribute(`data-iframe-${name}`)) || "",
		renderHTML: (attributes: Record<string, unknown>) =>
			typeof attributes[name] === "string" && attributes[name]
				? { [`data-iframe-${name}`]: attributes[name] }
				: {},
	};
}

function numberAttribute(name: string) {
	return {
		default: null,
		parseHTML: (element: HTMLElement) => {
			if (!copiedHere(element)) return null;
			const value = Number(element.getAttribute(`data-iframe-${name}`));
			return Number.isInteger(value) && value > 0 ? value : null;
		},
		renderHTML: (attributes: Record<string, unknown>) =>
			typeof attributes[name] === "number"
				? { [`data-iframe-${name}`]: String(attributes[name]) }
				: {},
	};
}

/**
 * TipTap extension: iframe block.
 *
 * A top-level atom. The editor's global drag handle moves it.
 */
export const IframeBlockExtension = Node.create({
	name: "iframeBlock",
	group: "topBlock",
	atom: true,
	draggable: false,
	selectable: true,

	addAttributes() {
		return {
			src: textAttribute("src"),
			title: textAttribute("title"),
			width: numberAttribute("width"),
			height: numberAttribute("height"),
			allow: textAttribute("allow"),
			allowFullscreen: {
				default: false,
				parseHTML: (element: HTMLElement) =>
					copiedHere(element) && element.hasAttribute("data-iframe-allowfullscreen"),
				renderHTML: (attributes: Record<string, unknown>) =>
					attributes.allowFullscreen === true ? { "data-iframe-allowfullscreen": "" } : {},
			},
		};
	},

	parseHTML() {
		return [{ tag: "div[data-iframe-block]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-iframe-block": "",
				"data-iframe-token": CLIPBOARD_TOKEN,
			}),
		];
	},

	addNodeView() {
		return embedBlockNodeView(this.editor, IframeBlockNodeView);
	},

	addKeyboardShortcuts() {
		return embedBlockKeyboardShortcuts(this.type);
	},
});
