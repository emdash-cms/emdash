/**
 * Self-contained inline Portable Text editor for visual editing.
 *
 * Uses TipTap directly with content extensions — no admin UI deps.
 * Includes BubbleMenu for inline formatting (bold, italic, etc.)
 * but no toolbar, no media picker, no section picker.
 *
 * Converts between Portable Text and ProseMirror on mount/save.
 * Auto-saves on blur, dispatches custom events for toolbar integration.
 */

import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { Extension, Mark, type JSONContent, type Range } from "@tiptap/core";
import Focus from "@tiptap/extension-focus";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Suggestion from "@tiptap/suggestion";
import * as React from "react";
import { createPortal } from "react-dom";

import { computeThumbnailSize } from "../media/thumbnail.js";

// ── Portable Text types ────────────────────────────────────────────

interface PTSpan {
	_type: "span";
	_key: string;
	text: string;
	marks?: string[];
}

interface PTMarkDef {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

interface PTTextBlock {
	_type: "block";
	_key: string;
	style?: "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote";
	listItem?: "bullet" | "number";
	level?: number;
	children: PTSpan[];
	markDefs?: PTMarkDef[];
	/** Custom CSS classes applied at the block level */
	cssClasses?: string;
}

type PTBlock = PTTextBlock | { _type: string; _key: string; [key: string]: unknown };

/** Type guard for PTTextBlock */
function isPTTextBlock(block: PTBlock): block is PTTextBlock {
	return block._type === "block";
}

/** Type guard for ProseMirror JSON document node */
function isPMNode(value: unknown): value is PMNode {
	return (
		typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
	);
}

// ── Helpers ────────────────────────────────────────────────────────

function k(): string {
	return Math.random().toString(36).substring(2, 11);
}

const CSS_WHITESPACE_RE = /\s+/;

/** Merge two CSS class strings, deduping whitespace tokens. */
function mergeClassTokens(a: string | undefined, b: string | undefined): string | undefined {
	if (!a) return b || undefined;
	if (!b) return a || undefined;
	const set = new Set<string>();
	for (const token of `${a} ${b}`.split(CSS_WHITESPACE_RE)) {
		if (token) set.add(token);
	}
	return set.size > 0 ? [...set].join(" ") : undefined;
}

function readCssClasses(obj: object | null | undefined): string | undefined {
	if (!obj) return undefined;
	const v = (obj as { cssClasses?: unknown }).cssClasses;
	return typeof v === "string" ? v : undefined;
}

// ── TipTap extensions for cssClasses preservation ──────────────────
//
// The inline visual editor must preserve `cssClasses` (block-level) and
// `cssClass` (inline mark) round-trip even though it doesn't expose a
// toolbar to toggle them — content authored in the admin is read-only here.
// Without these extensions, TipTap would strip the unknown attribute / mark
// during schema reconciliation on doc load, silently discarding all styles
// the moment a user clicks anything in the visual editor.

const InlineBlockStyleExtension = Extension.create({
	name: "blockStyle",
	addGlobalAttributes() {
		return [
			{
				types: [
					"paragraph",
					"heading",
					"blockquote",
					"listItem",
					"codeBlock",
					"horizontalRule",
					"image",
				],
				attributes: {
					cssClasses: {
						default: null,
						parseHTML: (el: HTMLElement) => el.getAttribute("data-css-classes") || null,
						renderHTML: (attributes: { cssClasses?: string | null }) => {
							if (!attributes.cssClasses) return {};
							return {
								"data-css-classes": attributes.cssClasses,
								class: attributes.cssClasses,
							};
						},
					},
				},
			},
		];
	},
});

const InlineCssClassMark = Mark.create({
	name: "cssClass",
	excludes: "",
	addAttributes() {
		return {
			classes: {
				default: null,
				parseHTML: (el: HTMLElement) => el.getAttribute("data-css-classes"),
				renderHTML: (attributes: { classes?: string | null }) => {
					if (!attributes.classes) return {};
					return {
						"data-css-classes": attributes.classes,
						class: attributes.classes,
					};
				},
			},
		};
	},
	parseHTML() {
		return [{ tag: "span[data-css-classes]" }];
	},
	renderHTML({ HTMLAttributes }) {
		return ["span", HTMLAttributes, 0];
	},
});

// ── ProseMirror → Portable Text ────────────────────────────────────

type PMNode = {
	type: string;
	attrs?: Record<string, unknown>;
	content?: PMNode[];
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
	text?: string;
};

/** Safely extract a string attribute from ProseMirror attrs */
function attrStr(attrs: Record<string, unknown> | undefined, key: string): string {
	const v = attrs?.[key];
	return typeof v === "string" ? v : "";
}

/** Safely extract an optional string attribute from ProseMirror attrs */
function attrStrOpt(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
	const v = attrs?.[key];
	return typeof v === "string" ? v : undefined;
}

/** Safely extract a number attribute from ProseMirror attrs */
function attrNum(attrs: Record<string, unknown> | undefined, key: string): number | undefined {
	const v = attrs?.[key];
	return typeof v === "number" ? v : undefined;
}

function pmToPortableText(doc: PMNode): PTBlock[] {
	if (!doc || doc.type !== "doc" || !doc.content) return [];
	const blocks: PTBlock[] = [];
	for (const node of doc.content) {
		const r = convertPMNode(node);
		if (r) {
			if (Array.isArray(r)) blocks.push(...r);
			else blocks.push(r);
		}
	}
	return blocks;
}

function convertPMNode(node: PMNode): PTBlock | PTBlock[] | null {
	const result = convertPMNodeInner(node);
	if (!result) return null;
	const outer = readCssClasses(node.attrs);
	if (!outer) return result;

	const merge = (b: PTBlock): PTBlock => {
		const inner = readCssClasses(b);
		const merged = mergeClassTokens(outer, inner);
		return merged ? ({ ...b, cssClasses: merged } as PTBlock) : b;
	};

	if (Array.isArray(result)) return result.map(merge);
	return merge(result);
}

function convertPMNodeInner(node: PMNode): PTBlock | PTBlock[] | null {
	switch (node.type) {
		case "paragraph": {
			const { children, markDefs } = convertInline(node.content || []);
			if (children.length === 0) return null;
			return {
				_type: "block",
				_key: k(),
				style: "normal",
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			};
		}
		case "heading": {
			const { children, markDefs } = convertInline(node.content || []);
			const level = attrNum(node.attrs, "level") ?? 1;
			if (children.length === 0) return null;
			const headingStyles: Record<number, PTTextBlock["style"]> = {
				1: "h1",
				2: "h2",
				3: "h3",
				4: "h4",
				5: "h5",
				6: "h6",
			};
			const headingStyle = headingStyles[level] ?? "h1";
			return {
				_type: "block",
				_key: k(),
				style: headingStyle,
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			};
		}
		case "bulletList":
			return convertPMList(node.content || [], "bullet");
		case "orderedList":
			return convertPMList(node.content || [], "number");
		case "blockquote": {
			const blocks: PTTextBlock[] = [];
			for (const child of node.content || []) {
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInline(child.content || []);
					if (children.length > 0) {
						const innerClasses =
							typeof child.attrs?.cssClasses === "string" ? child.attrs.cssClasses : undefined;
						const block: PTTextBlock = {
							_type: "block",
							_key: k(),
							style: "blockquote",
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						};
						if (innerClasses) {
							block.cssClasses = innerClasses;
						}
						blocks.push(block);
					}
				}
			}
			if (blocks.length === 1) {
				const first = blocks[0];
				return first ?? null;
			}
			return blocks.length > 0 ? blocks : null;
		}
		case "codeBlock": {
			const code = (node.content || []).map((n) => n.text || "").join("");
			return {
				_type: "code",
				_key: k(),
				code,
				language: attrStrOpt(node.attrs, "language"),
			};
		}
		case "image": {
			const provider = attrStrOpt(node.attrs, "provider");
			return {
				_type: "image",
				_key: k(),
				asset: {
					_ref: attrStr(node.attrs, "mediaId"),
					url: attrStr(node.attrs, "src"),
					provider: provider && provider !== "local" ? provider : undefined,
				},
				alt: attrStrOpt(node.attrs, "alt"),
				caption: attrStrOpt(node.attrs, "caption") ?? attrStrOpt(node.attrs, "title"),
				width: attrNum(node.attrs, "width"),
				height: attrNum(node.attrs, "height"),
				displayWidth: attrNum(node.attrs, "displayWidth"),
				displayHeight: attrNum(node.attrs, "displayHeight"),
			};
		}
		case "horizontalRule":
			return { _type: "break", _key: k(), style: "lineBreak" };
		case "pluginBlock":
			return {
				_type: attrStr(node.attrs, "blockType") || "embed",
				_key: k(),
				id: attrStr(node.attrs, "id"),
			};
		default:
			return null;
	}
}

function convertPMList(items: PMNode[], listItem: "bullet" | "number"): PTTextBlock[] {
	const blocks: PTTextBlock[] = [];
	for (const item of items) {
		if (item.type === "listItem") {
			const itemClasses =
				typeof item.attrs?.cssClasses === "string" ? item.attrs.cssClasses : undefined;
			for (const child of item.content || []) {
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInline(child.content || []);
					if (children.length > 0) {
						const paraClasses =
							typeof child.attrs?.cssClasses === "string" ? child.attrs.cssClasses : undefined;
						const merged = mergeClassTokens(itemClasses, paraClasses);
						const block: PTTextBlock = {
							_type: "block",
							_key: k(),
							style: "normal",
							listItem,
							level: 1,
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						};
						if (merged) {
							block.cssClasses = merged;
						}
						blocks.push(block);
					}
				}
			}
		}
	}
	return blocks;
}

function convertInline(nodes: PMNode[]): { children: PTSpan[]; markDefs: PTMarkDef[] } {
	const children: PTSpan[] = [];
	const markDefs: PTMarkDef[] = [];
	const markDefMap = new Map<string, string>();

	for (const node of nodes) {
		if (node.type === "text" && node.text) {
			const marks: string[] = [];
			for (const mark of node.marks || []) {
				const m = convertPMMark(mark, markDefs, markDefMap);
				if (m) marks.push(m);
			}
			children.push({
				_type: "span",
				_key: k(),
				text: node.text,
				marks: marks.length > 0 ? marks : undefined,
			});
		} else if (node.type === "hardBreak") {
			if (children.length > 0) {
				const last = children.at(-1);
				if (last) last.text += "\n";
			} else {
				children.push({ _type: "span", _key: k(), text: "\n" });
			}
		}
	}

	if (children.length === 0) {
		children.push({ _type: "span", _key: k(), text: "" });
	}
	return { children, markDefs };
}

function convertPMMark(
	mark: { type: string; attrs?: Record<string, unknown> },
	markDefs: PTMarkDef[],
	markDefMap: Map<string, string>,
): string | null {
	switch (mark.type) {
		case "bold":
		case "strong":
			return "strong";
		case "italic":
		case "em":
			return "em";
		case "underline":
			return "underline";
		case "strike":
		case "strikethrough":
			return "strike-through";
		case "code":
			return "code";
		case "link": {
			const href = attrStr(mark.attrs, "href");
			if (markDefMap.has(href)) return markDefMap.get(href)!;
			const key = k();
			markDefs.push({
				_type: "link",
				_key: key,
				href,
				blank: mark.attrs?.target === "_blank",
			});
			markDefMap.set(href, key);
			return key;
		}
		case "cssClass": {
			const classes = attrStrOpt(mark.attrs, "classes") || "";
			if (!classes) return null;
			const dedupeKey = `cssClass:${classes}`;
			if (markDefMap.has(dedupeKey)) return markDefMap.get(dedupeKey)!;
			const key = k();
			markDefs.push({
				_type: "cssClass",
				_key: key,
				classes,
			});
			markDefMap.set(dedupeKey, key);
			return key;
		}
		default:
			return mark.type;
	}
}

// ── Portable Text → ProseMirror ────────────────────────────────────

function portableTextToPM(blocks: PTBlock[]): JSONContent {
	if (!blocks || blocks.length === 0) return { type: "doc", content: [{ type: "paragraph" }] };

	const content: JSONContent[] = [];
	let i = 0;

	while (i < blocks.length) {
		const block = blocks[i];
		if (!block) {
			i++;
			continue;
		}
		if (isPTTextBlock(block) && block.listItem) {
			const listBlocks: PTTextBlock[] = [];
			const listType = block.listItem;
			while (i < blocks.length) {
				const cur = blocks[i];
				if (cur && isPTTextBlock(cur) && cur.listItem === listType) {
					listBlocks.push(cur);
					i++;
				} else break;
			}
			content.push(convertPTList(listBlocks, listType));
		} else {
			const c = convertPTBlock(block);
			if (c) content.push(c);
			i++;
		}
	}

	return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

function ptCssClasses(block: PTBlock): string | undefined {
	const v = readCssClasses(block);
	return v && v.length > 0 ? v : undefined;
}

function convertPTBlock(block: PTBlock): JSONContent | null {
	const node = convertPTBlockInner(block);
	if (!node) return null;
	const cssClasses = ptCssClasses(block);
	if (!cssClasses) return node;
	return { ...node, attrs: { ...node.attrs, cssClasses } };
}

function convertPTBlockInner(block: PTBlock): JSONContent | null {
	if (isPTTextBlock(block)) {
		const { style = "normal", children, markDefs = [] } = block;
		const pmContent = convertPTSpans(children, markDefs);

		if (style === "blockquote") {
			return {
				type: "blockquote",
				content: [
					{
						type: "paragraph",
						content: pmContent.length > 0 ? pmContent : undefined,
					},
				],
			};
		}
		if (style?.startsWith("h")) {
			const level = parseInt(style.substring(1), 10);
			return {
				type: "heading",
				attrs: { level },
				content: pmContent.length > 0 ? pmContent : undefined,
			};
		}
		return {
			type: "paragraph",
			content: pmContent.length > 0 ? pmContent : undefined,
		};
	}
	if (block._type === "code") {
		const cb = block as PTBlock & { code?: string; language?: string };
		return {
			type: "codeBlock",
			attrs: { language: cb.language || null },
			content: cb.code ? [{ type: "text", text: cb.code }] : undefined,
		};
	}
	if (block._type === "break") {
		return { type: "horizontalRule" };
	}
	if (block._type === "image") {
		const ib = block as PTBlock & {
			asset?: { _ref?: string; url?: string; provider?: string };
			url?: string;
			alt?: string;
			caption?: string;
			width?: number;
			height?: number;
			displayWidth?: number;
			displayHeight?: number;
		};
		const asset = ib.asset;
		return {
			type: "image",
			attrs: {
				src: asset?.url || ib.url || (asset?._ref ? `/_emdash/api/media/file/${asset._ref}` : ""),
				alt: ib.alt || "",
				title: ib.caption || "",
				caption: ib.caption || "",
				mediaId: asset?._ref,
				provider: asset?.provider,
				width: ib.width,
				height: ib.height,
				displayWidth: ib.displayWidth,
				displayHeight: ib.displayHeight,
			},
		};
	}
	// Unknown block types — treat as plugin blocks if they have an id
	const embedBlock = block as { _type: string; url?: string; id?: string };
	if (embedBlock.id || embedBlock.url) {
		return {
			type: "pluginBlock",
			attrs: {
				blockType: block._type,
				id: embedBlock.id || embedBlock.url || "",
			},
		};
	}
	// Truly unknown — render as code-marked text
	return {
		type: "paragraph",
		content: [{ type: "text", text: `[${block._type}]`, marks: [{ type: "code" }] }],
	};
}

function convertPTList(items: PTTextBlock[], listType: "bullet" | "number"): JSONContent {
	return {
		type: listType === "bullet" ? "bulletList" : "orderedList",
		content: items.map((item) => {
			const cssClasses = ptCssClasses(item);
			const node: JSONContent = {
				type: "listItem",
				content: [
					{
						type: "paragraph",
						content: convertPTSpans(item.children, item.markDefs || []),
					},
				],
			};
			if (cssClasses) {
				node.attrs = { cssClasses };
			}
			return node;
		}),
	};
}

function convertPTSpans(spans: PTSpan[], markDefs: PTMarkDef[]): JSONContent[] {
	const nodes: JSONContent[] = [];
	const mdMap = new Map(markDefs.map((md) => [md._key, md]));

	for (const span of spans) {
		if (span._type !== "span") continue;
		const parts = span.text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			const text = parts[i];
			if (text && text.length > 0) {
				const marks = convertPTMarks(span.marks || [], mdMap);
				const node: JSONContent = {
					type: "text",
					text,
				};
				if (marks.length > 0) node.marks = marks;
				nodes.push(node);
			}
			if (i < parts.length - 1) nodes.push({ type: "hardBreak" });
		}
	}
	return nodes;
}

type MarkJSON = { type: string; attrs?: Record<string, unknown>; [key: string]: unknown };

function convertPTMarks(marks: string[], markDefs: Map<string, PTMarkDef>): MarkJSON[] {
	const pm: MarkJSON[] = [];
	for (const mark of marks) {
		switch (mark) {
			case "strong":
				pm.push({ type: "bold" });
				break;
			case "em":
				pm.push({ type: "italic" });
				break;
			case "underline":
				pm.push({ type: "underline" });
				break;
			case "strike-through":
				pm.push({ type: "strike" });
				break;
			case "code":
				pm.push({ type: "code" });
				break;
			default: {
				const md = markDefs.get(mark);
				if (md && md._type === "link") {
					pm.push({
						type: "link",
						attrs: { href: md.href, target: md.blank ? "_blank" : null },
					});
				} else if (md && md._type === "cssClass") {
					pm.push({
						type: "cssClass",
						attrs: { classes: md.classes },
					});
				}
				break;
			}
		}
	}
	return pm;
}

// ── Inline BubbleMenu ──────────────────────────────────────────────

function InlineBubbleMenu({ editor }: { editor: Editor }) {
	const [showLinkInput, setShowLinkInput] = React.useState(false);
	const [linkUrl, setLinkUrl] = React.useState("");
	const inputRef = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		if (showLinkInput) {
			const existingUrl = editor.getAttributes("link").href || "";
			setLinkUrl(existingUrl);
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [showLinkInput, editor]);

	const handleSetLink = () => {
		if (linkUrl.trim() === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
		} else {
			editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl.trim() }).run();
		}
		setShowLinkInput(false);
		setLinkUrl("");
	};

	const handleRemoveLink = () => {
		editor.chain().focus().extendMarkRange("link").unsetLink().run();
		setShowLinkInput(false);
		setLinkUrl("");
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSetLink();
		} else if (e.key === "Escape") {
			setShowLinkInput(false);
			setLinkUrl("");
			editor.commands.focus();
		}
	};

	return (
		<BubbleMenu
			editor={editor}
			options={{ placement: "top", offset: 8, flip: true, shift: true }}
			className="emdash-bubble-menu"
		>
			{showLinkInput ? (
				<div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
					<input
						ref={inputRef}
						type="url"
						placeholder="https://..."
						value={linkUrl}
						onChange={(e) => setLinkUrl(e.target.value)}
						onKeyDown={handleKeyDown}
						className="emdash-bubble-link-input"
					/>
					<button
						type="button"
						className="emdash-bubble-btn"
						onClick={handleSetLink}
						title="Apply link"
					>
						↗
					</button>
					{editor.isActive("link") && (
						<button
							type="button"
							className="emdash-bubble-btn emdash-bubble-btn--danger"
							onClick={handleRemoveLink}
							title="Remove link"
						>
							✕
						</button>
					)}
				</div>
			) : (
				<>
					<button
						type="button"
						className={`emdash-bubble-btn ${editor.isActive("bold") ? "emdash-bubble-btn--active" : ""}`}
						onClick={() => editor.chain().focus().toggleBold().run()}
						title="Bold"
					>
						<strong>B</strong>
					</button>
					<button
						type="button"
						className={`emdash-bubble-btn ${editor.isActive("italic") ? "emdash-bubble-btn--active" : ""}`}
						onClick={() => editor.chain().focus().toggleItalic().run()}
						title="Italic"
					>
						<em>I</em>
					</button>
					<button
						type="button"
						className={`emdash-bubble-btn ${editor.isActive("underline") ? "emdash-bubble-btn--active" : ""}`}
						onClick={() => editor.chain().focus().toggleUnderline().run()}
						title="Underline"
					>
						<span style={{ textDecoration: "underline" }}>U</span>
					</button>
					<button
						type="button"
						className={`emdash-bubble-btn ${editor.isActive("strike") ? "emdash-bubble-btn--active" : ""}`}
						onClick={() => editor.chain().focus().toggleStrike().run()}
						title="Strikethrough"
					>
						<span style={{ textDecoration: "line-through" }}>S</span>
					</button>
					<button
						type="button"
						className={`emdash-bubble-btn ${editor.isActive("code") ? "emdash-bubble-btn--active" : ""}`}
						onClick={() => editor.chain().focus().toggleCode().run()}
						title="Code"
					>
						<span style={{ fontFamily: "monospace", fontSize: "13px" }}>&lt;/&gt;</span>
					</button>
					<span className="emdash-bubble-divider" />
					<button
						type="button"
						className={`emdash-bubble-btn ${editor.isActive("link") ? "emdash-bubble-btn--active" : ""}`}
						onClick={() => setShowLinkInput(true)}
						title={editor.isActive("link") ? "Edit link" : "Add link"}
					>
						🔗
					</button>
				</>
			)}
		</BubbleMenu>
	);
}

// ── Slash Menu ──────────────────────────────────────────────────────

interface SlashCommandItem {
	id: string;
	title: string;
	description: string;
	icon: string;
	command: (props: { editor: Editor; range: Range }) => void;
	aliases?: string[];
}

const slashCommands: SlashCommandItem[] = [
	{
		id: "heading1",
		title: "Heading 1",
		description: "Large section heading",
		icon: "H1",
		aliases: ["h1", "title"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run();
		},
	},
	{
		id: "heading2",
		title: "Heading 2",
		description: "Medium section heading",
		icon: "H2",
		aliases: ["h2", "subtitle"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run();
		},
	},
	{
		id: "heading3",
		title: "Heading 3",
		description: "Small section heading",
		icon: "H3",
		aliases: ["h3"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run();
		},
	},
	{
		id: "bulletList",
		title: "Bullet List",
		description: "Create a bullet list",
		icon: "•",
		aliases: ["ul", "unordered"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleBulletList().run();
		},
	},
	{
		id: "numberedList",
		title: "Numbered List",
		description: "Create a numbered list",
		icon: "1.",
		aliases: ["ol", "ordered"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleOrderedList().run();
		},
	},
	{
		id: "quote",
		title: "Quote",
		description: "Insert a blockquote",
		icon: "\u201C",
		aliases: ["blockquote", "cite"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleBlockquote().run();
		},
	},
	{
		id: "codeBlock",
		title: "Code Block",
		description: "Insert a code block",
		icon: "</>",
		aliases: ["code", "pre", "```"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
		},
	},
	{
		id: "divider",
		title: "Divider",
		description: "Insert a horizontal rule",
		icon: "—",
		aliases: ["hr", "---", "separator"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setHorizontalRule().run();
		},
	},
	{
		id: "image",
		title: "Image",
		description: "Insert an image",
		icon: "🖼",
		aliases: ["img", "photo", "picture"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).run();
			// Signal the component to open the media picker
			document.dispatchEvent(new CustomEvent("emdash:open-media-picker"));
		},
	},
];

interface SlashMenuState {
	isOpen: boolean;
	items: SlashCommandItem[];
	selectedIndex: number;
	clientRect: (() => DOMRect | null) | null;
	range: Range | null;
}

const initialSlashMenuState: SlashMenuState = {
	isOpen: false,
	items: [],
	selectedIndex: 0,
	clientRect: null,
	range: null,
};

function createSlashCommandsExtension(options: {
	filterCommands: (query: string) => SlashCommandItem[];
	onStateChange: React.Dispatch<React.SetStateAction<SlashMenuState>>;
	getState: () => SlashMenuState;
}) {
	const { filterCommands, onStateChange, getState } = options;

	return Extension.create({
		name: "slashCommands",

		addProseMirrorPlugins() {
			return [
				Suggestion({
					editor: this.editor,
					char: "/",
					startOfLine: true,
					command: ({ editor, range, props }) => {
						const item: unknown = props;
						if (
							typeof item === "object" &&
							item !== null &&
							"command" in item &&
							typeof item.command === "function"
						) {
							item.command({ editor, range });
						}
					},
					items: ({ query }) => filterCommands(query),
					render: () => {
						return {
							onStart: (props) => {
								onStateChange({
									isOpen: true,
									items: props.items,
									selectedIndex: 0,
									clientRect: props.clientRect ?? null,
									range: props.range,
								});
							},
							onUpdate: (props) => {
								onStateChange((prev) => ({
									...prev,
									items: props.items,
									selectedIndex: 0,
									clientRect: props.clientRect ?? null,
									range: props.range,
								}));
							},
							onKeyDown: (props) => {
								if (props.event.key === "Escape") {
									onStateChange((prev) => ({ ...prev, isOpen: false }));
									return true;
								}
								if (props.event.key === "ArrowUp") {
									onStateChange((prev) => ({
										...prev,
										selectedIndex: (prev.selectedIndex - 1 + prev.items.length) % prev.items.length,
									}));
									return true;
								}
								if (props.event.key === "ArrowDown") {
									onStateChange((prev) => ({
										...prev,
										selectedIndex: (prev.selectedIndex + 1) % prev.items.length,
									}));
									return true;
								}
								if (props.event.key === "Enter") {
									const state = getState();
									if (state.items.length > 0 && state.range) {
										const item = state.items[state.selectedIndex];
										if (item) {
											item.command({ editor: this.editor, range: state.range });
											onStateChange((prev) => ({ ...prev, isOpen: false }));
											return true;
										}
									}
									return false;
								}
								return false;
							},
							onExit: () => {
								onStateChange((prev) => ({ ...prev, isOpen: false }));
							},
						};
					},
				}),
			];
		},
	});
}

function InlineSlashMenu({
	state,
	onCommand,
	setSelectedIndex,
}: {
	state: SlashMenuState;
	onCommand: (item: SlashCommandItem) => void;
	setSelectedIndex: (index: number) => void;
}) {
	const containerRef = React.useRef<HTMLDivElement>(null);

	// Track whether we have a positioned reference to avoid rendering at (0,0)
	const [hasReference, setHasReference] = React.useState(false);

	const { refs, floatingStyles } = useFloating({
		open: state.isOpen && hasReference,
		placement: "bottom-start",
		middleware: [offset(8), flip(), shift({ padding: 8 })],
		whileElementsMounted: autoUpdate,
	});

	React.useEffect(() => {
		if (state.clientRect) {
			const clientRectFn = state.clientRect;
			refs.setReference({
				getBoundingClientRect: () => clientRectFn() ?? new DOMRect(),
			});
			setHasReference(true);
		} else {
			setHasReference(false);
		}
	}, [state.clientRect, refs]);

	// Reset reference tracking when menu closes
	React.useEffect(() => {
		if (!state.isOpen) setHasReference(false);
	}, [state.isOpen]);

	React.useEffect(() => {
		if (!state.isOpen || !hasReference) return;
		const container = containerRef.current;
		if (!container) return;
		const selected = container.querySelector(`[data-index="${state.selectedIndex}"]`);
		if (selected instanceof HTMLElement) {
			// Use scrollIntoView only within the menu container to avoid scrolling the page
			const containerTop = container.scrollTop;
			const containerBottom = containerTop + container.clientHeight;
			const itemTop = selected.offsetTop;
			const itemBottom = itemTop + selected.offsetHeight;
			if (itemTop < containerTop) {
				container.scrollTop = itemTop;
			} else if (itemBottom > containerBottom) {
				container.scrollTop = itemBottom - container.clientHeight;
			}
		}
	}, [state.selectedIndex, state.isOpen, hasReference]);

	if (!state.isOpen || !hasReference) return null;

	return createPortal(
		<div
			ref={(node) => {
				containerRef.current = node;
				refs.setFloating(node);
			}}
			style={{
				...floatingStyles,
				zIndex: 100,
				borderRadius: "8px",
				border: "1px solid #d1d5db",
				background: "white",
				padding: "4px",
				boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
				minWidth: "220px",
				maxHeight: "300px",
				overflowY: "auto",
			}}
			className="emdash-slash-menu"
		>
			{state.items.length === 0 ? (
				<p
					style={{
						padding: "8px 12px",
						fontSize: "13px",
						color: "#9ca3af",
						margin: 0,
					}}
				>
					No results
				</p>
			) : (
				state.items.map((item, index) => (
					<button
						key={item.id}
						type="button"
						data-index={index}
						style={{
							display: "flex",
							alignItems: "center",
							gap: "12px",
							width: "100%",
							padding: "8px 12px",
							fontSize: "13px",
							borderRadius: "4px",
							border: "none",
							textAlign: "left",
							cursor: "pointer",
							background: index === state.selectedIndex ? "#f3f4f6" : "transparent",
						}}
						onClick={() => onCommand(item)}
						onMouseEnter={() => setSelectedIndex(index)}
					>
						<span
							style={{
								width: "24px",
								height: "24px",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								flexShrink: 0,
								fontSize: "14px",
								fontWeight: 600,
								color: "#6b7280",
								background: "#f3f4f6",
								borderRadius: "4px",
							}}
						>
							{item.icon}
						</span>
						<span style={{ display: "flex", flexDirection: "column" }}>
							<span style={{ fontWeight: 500 }}>{item.title}</span>
							<span style={{ fontSize: "12px", color: "#9ca3af" }}>{item.description}</span>
						</span>
					</button>
				))
			)}
		</div>,
		document.body,
	);
}

// ── Media Picker ───────────────────────────────────────────────────

interface MediaItemData {
	id: string;
	filename: string;
	mimeType: string;
	url: string;
	storageKey?: string;
	width?: number;
	height?: number;
	alt?: string;
	provider?: string;
	previewUrl?: string;
	meta?: Record<string, unknown>;
}

interface ProviderInfo {
	id: string;
	name: string;
	icon?: string;
	capabilities: { browse: boolean; search: boolean; upload: boolean; delete: boolean };
}

const API_BASE = "/_emdash/api";

async function ecFetch(url: string, init?: RequestInit): Promise<Response> {
	const base = new Headers(init?.headers);
	base.set("X-EmDash-Request", "1");
	return fetch(url, {
		credentials: "same-origin",
		...init,
		headers: base,
	});
}

function InlineMediaPicker({
	open,
	onClose,
	onSelect,
}: {
	open: boolean;
	onClose: () => void;
	onSelect: (item: MediaItemData) => void;
}) {
	const [providers, setProviders] = React.useState<ProviderInfo[]>([]);
	const [activeProvider, setActiveProvider] = React.useState("local");
	const [items, setItems] = React.useState<MediaItemData[]>([]);
	const [loading, setLoading] = React.useState(false);
	const [uploading, setUploading] = React.useState(false);
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const fileInputRef = React.useRef<HTMLInputElement>(null);

	// Fetch providers on open
	React.useEffect(() => {
		if (!open) return;
		setSelectedId(null);
		setActiveProvider("local");
		ecFetch(`${API_BASE}/media/providers`)
			.then((r) => r.json())
			.then((d) => setProviders(d.data.items ?? []))
			.catch(() => setProviders([]));
	}, [open]);

	// Fetch items when provider changes
	React.useEffect(() => {
		if (!open) return;
		setLoading(true);
		setSelectedId(null);

		const url =
			activeProvider === "local"
				? `${API_BASE}/media?mimeType=image/&limit=50`
				: `${API_BASE}/media/providers/${activeProvider}?mimeType=image/&limit=50`;

		void (async () => {
			try {
				const r = await ecFetch(url);
				const d = await r.json();
				const raw = d.data.items ?? [];
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- API response items mapped to MediaItem shape
				const typedRaw = raw as Array<{
					id: string;
					filename?: string;
					mimeType?: string;
					url?: string;
					previewUrl?: string;
					storageKey?: string;
					width?: number;
					height?: number;
					alt?: string;
					meta?: Record<string, unknown>;
				}>;
				setItems(
					typedRaw.map((item) => ({
						id: item.id,
						filename: item.filename || "",
						mimeType: item.mimeType || "image/unknown",
						url:
							item.url ||
							item.previewUrl ||
							(item.storageKey ? `${API_BASE}/media/file/${item.storageKey}` : ""),
						storageKey: item.storageKey,
						width: item.width,
						height: item.height,
						alt: item.alt,
						provider: activeProvider === "local" ? undefined : activeProvider,
						previewUrl: item.previewUrl,
						meta: item.meta,
					})),
				);
			} catch {
				setItems([]);
			} finally {
				setLoading(false);
			}
		})();
	}, [open, activeProvider]);

	const handleUpload = async (file: File) => {
		setUploading(true);
		try {
			// Detect dimensions and generate a thumbnail for large images to
			// avoid OOM in server-side blurhash generation on Workers.
			const dims = await new Promise<{
				width?: number;
				height?: number;
				thumbnail?: Blob;
			}>((resolve) => {
				if (!file.type.startsWith("image/")) return resolve({});
				const img = new window.Image();
				img.onload = () => {
					const w = img.naturalWidth;
					const h = img.naturalHeight;
					// 32 MB RGBA threshold — matches server MAX_DECODED_BYTES
					if (w * h * 4 > 32 * 1024 * 1024) {
						const { width: thumbW, height: thumbH } = computeThumbnailSize(w, h);
						try {
							const canvas = document.createElement("canvas");
							canvas.width = thumbW;
							canvas.height = thumbH;
							const ctx = canvas.getContext("2d");
							if (ctx) {
								ctx.drawImage(img, 0, 0, thumbW, thumbH);
								canvas.toBlob((blob) => {
									URL.revokeObjectURL(img.src);
									resolve({ width: w, height: h, thumbnail: blob ?? undefined });
								}, "image/png");
								return;
							}
						} catch {
							// Canvas allocation or draw failed — fall through to no-thumbnail path
						}
					}
					URL.revokeObjectURL(img.src);
					resolve({ width: w, height: h });
				};
				img.onerror = () => {
					resolve({});
					URL.revokeObjectURL(img.src);
				};
				img.src = URL.createObjectURL(file);
			});

			let item: MediaItemData;

			if (activeProvider === "local") {
				const formData = new FormData();
				formData.append("file", file);
				if (dims.width) formData.append("width", String(dims.width));
				if (dims.height) formData.append("height", String(dims.height));
				if (dims.thumbnail) formData.append("thumbnail", dims.thumbnail, "thumb.png");
				const res = await ecFetch(`${API_BASE}/media`, { method: "POST", body: formData });
				const data = await res.json();
				const unwrapped = data.data ?? data;
				if (!unwrapped.item) throw new Error("Upload failed");
				const raw = unwrapped.item;
				item = {
					id: raw.id,
					filename: raw.filename || file.name,
					mimeType: raw.mimeType || file.type,
					url: raw.url || raw.previewUrl || `${API_BASE}/media/file/${raw.storageKey}`,
					storageKey: raw.storageKey,
					width: raw.width || dims.width,
					height: raw.height || dims.height,
					alt: raw.alt,
				};
			} else {
				const formData = new FormData();
				formData.append("file", file);
				const res = await ecFetch(`${API_BASE}/media/providers/${activeProvider}`, {
					method: "POST",
					body: formData,
				});
				const data = await res.json();
				const unwrapped = data.data ?? data;
				if (!unwrapped.item) throw new Error("Upload failed");
				const raw = unwrapped.item;
				item = {
					id: raw.id,
					filename: raw.filename || file.name,
					mimeType: raw.mimeType || file.type,
					url: raw.previewUrl || "",
					width: raw.width || dims.width,
					height: raw.height || dims.height,
					alt: raw.alt,
					provider: activeProvider,
					previewUrl: raw.previewUrl,
					meta: raw.meta,
				};
			}

			setItems((prev) => [item, ...prev]);
			setSelectedId(item.id);
		} catch (err) {
			console.error("Upload failed:", err);
		} finally {
			setUploading(false);
		}
	};

	const handleConfirm = () => {
		const item = items.find((i) => i.id === selectedId);
		if (item) onSelect(item);
	};

	const providerTabs = React.useMemo(() => {
		const tabs: Array<{ id: string; name: string; icon?: string }> = [
			{ id: "local", name: "Library" },
		];
		for (const p of providers) {
			if (p.id !== "local") tabs.push({ id: p.id, name: p.name, icon: p.icon });
		}
		return tabs;
	}, [providers]);

	if (!open) return null;

	return createPortal(
		<div
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 10000,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "rgba(0,0,0,0.5)",
				fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				style={{
					background: "white",
					borderRadius: "12px",
					width: "min(700px, 90vw)",
					maxHeight: "80vh",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
					boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
				}}
				className="emdash-media-picker"
			>
				{/* Header */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "16px 20px",
						borderBottom: "1px solid #e5e7eb",
					}}
				>
					<span style={{ fontSize: "16px", fontWeight: 600 }}>Insert Image</span>
					<button
						type="button"
						onClick={onClose}
						style={{
							background: "none",
							border: "none",
							cursor: "pointer",
							fontSize: "18px",
							padding: "4px 8px",
							borderRadius: "4px",
							color: "#6b7280",
						}}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				{/* Provider tabs */}
				{providerTabs.length > 1 && (
					<div
						style={{
							display: "flex",
							gap: "6px",
							padding: "12px 20px",
							borderBottom: "1px solid #e5e7eb",
							flexWrap: "wrap",
						}}
					>
						{providerTabs.map((tab) => (
							<button
								key={tab.id}
								type="button"
								onClick={() => setActiveProvider(tab.id)}
								style={{
									padding: "6px 14px",
									fontSize: "13px",
									fontWeight: 500,
									borderRadius: "6px",
									border: "none",
									cursor: "pointer",
									background: activeProvider === tab.id ? "#3b82f6" : "#f3f4f6",
									color: activeProvider === tab.id ? "white" : "#4b5563",
								}}
							>
								{tab.icon && (
									<span
										style={{ marginRight: "6px", display: "inline-flex", alignItems: "center" }}
									>
										{tab.icon.startsWith("data:") || tab.icon.startsWith("http") ? (
											<img src={tab.icon} alt="" style={{ width: "16px", height: "16px" }} />
										) : (
											tab.icon
										)}
									</span>
								)}
								{tab.name}
							</button>
						))}
					</div>
				)}

				{/* Upload bar */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "12px 20px",
						borderBottom: "1px solid #e5e7eb",
					}}
				>
					<span style={{ fontSize: "13px", color: "#6b7280" }}>
						{loading ? "Loading…" : `${items.length} image${items.length !== 1 ? "s" : ""}`}
					</span>
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						disabled={uploading}
						style={{
							padding: "6px 14px",
							fontSize: "13px",
							fontWeight: 500,
							borderRadius: "6px",
							border: "1px solid #d1d5db",
							cursor: uploading ? "not-allowed" : "pointer",
							background: "white",
							color: "#374151",
							opacity: uploading ? 0.6 : 1,
						}}
					>
						{uploading ? "Uploading…" : "Upload"}
					</button>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						style={{ display: "none" }}
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void handleUpload(file);
							if (fileInputRef.current) fileInputRef.current.value = "";
						}}
					/>
				</div>

				{/* Grid */}
				<div
					style={{
						flex: 1,
						overflowY: "auto",
						padding: "16px 20px",
						minHeight: "250px",
					}}
				>
					{loading ? (
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								height: "200px",
								color: "#9ca3af",
								fontSize: "14px",
							}}
						>
							Loading…
						</div>
					) : items.length === 0 ? (
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								justifyContent: "center",
								height: "200px",
								color: "#9ca3af",
								fontSize: "14px",
								textAlign: "center",
							}}
						>
							<div style={{ fontSize: "32px", marginBottom: "8px" }}>🖼</div>
							No images found
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								style={{
									marginTop: "12px",
									padding: "8px 16px",
									fontSize: "13px",
									borderRadius: "6px",
									border: "1px solid #d1d5db",
									background: "white",
									cursor: "pointer",
									color: "#374151",
								}}
							>
								Upload an image
							</button>
						</div>
					) : (
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
								gap: "10px",
							}}
						>
							{items.map((item) => {
								const isSelected = selectedId === item.id;
								const thumb = item.url || item.previewUrl || "";
								return (
									<button
										key={item.id}
										type="button"
										onClick={() => setSelectedId(item.id)}
										onDoubleClick={() => onSelect(item)}
										style={{
											position: "relative",
											aspectRatio: "1",
											borderRadius: "8px",
											border: isSelected ? "2px solid #3b82f6" : "2px solid transparent",
											overflow: "hidden",
											cursor: "pointer",
											padding: 0,
											background: "#f3f4f6",
											outline: isSelected ? "2px solid rgba(59,130,246,0.3)" : "none",
											outlineOffset: "1px",
										}}
										aria-label={item.filename}
									>
										{thumb ? (
											<img
												src={thumb}
												alt=""
												style={{ width: "100%", height: "100%", objectFit: "cover" }}
											/>
										) : (
											<div
												style={{
													width: "100%",
													height: "100%",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													fontSize: "24px",
												}}
											>
												🖼
											</div>
										)}
										{isSelected && (
											<div
												style={{
													position: "absolute",
													inset: 0,
													background: "rgba(59,130,246,0.15)",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
												}}
											>
												<div
													style={{
														width: "24px",
														height: "24px",
														borderRadius: "50%",
														background: "#3b82f6",
														color: "white",
														display: "flex",
														alignItems: "center",
														justifyContent: "center",
														fontSize: "14px",
													}}
												>
													✓
												</div>
											</div>
										)}
										<div
											style={{
												position: "absolute",
												bottom: 0,
												left: 0,
												right: 0,
												background: "linear-gradient(transparent, rgba(0,0,0,0.6))",
												padding: "16px 6px 4px",
											}}
										>
											<div
												style={{
													fontSize: "11px",
													color: "white",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{item.filename}
											</div>
										</div>
									</button>
								);
							})}
						</div>
					)}
				</div>

				{/* Footer */}
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: "8px",
						padding: "12px 20px",
						borderTop: "1px solid #e5e7eb",
					}}
				>
					<button
						type="button"
						onClick={onClose}
						style={{
							padding: "8px 16px",
							fontSize: "13px",
							fontWeight: 500,
							borderRadius: "6px",
							border: "1px solid #d1d5db",
							background: "white",
							cursor: "pointer",
							color: "#374151",
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={!selectedId}
						style={{
							padding: "8px 16px",
							fontSize: "13px",
							fontWeight: 500,
							borderRadius: "6px",
							border: "none",
							background: selectedId ? "#3b82f6" : "#93c5fd",
							color: "white",
							cursor: selectedId ? "pointer" : "not-allowed",
						}}
					>
						Insert
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

// ── Internal exports for tests ─────────────────────────────────────
// Underscore-prefixed: not part of the public API. Used by unit tests
// to verify converter round-trip behavior without instantiating React.
export { pmToPortableText as _pmToPortableText, portableTextToPM as _portableTextToPM };

// ── Component ──────────────────────────────────────────────────────

export interface InlinePortableTextEditorProps {
	value: PTBlock[];
	collection: string;
	entryId: string;
	field: string;
}

export function InlinePortableTextEditor({
	value,
	collection,
	entryId,
	field,
}: InlinePortableTextEditorProps) {
	const initialRef = React.useRef(value);
	const savingRef = React.useRef(false);
	const editorRef = React.useRef<ReturnType<typeof useEditor>>(null);

	// Media picker state
	const [mediaPickerOpen, setMediaPickerOpen] = React.useState(false);

	// Listen for the slash command's media picker event
	React.useEffect(() => {
		const handler = () => setMediaPickerOpen(true);
		document.addEventListener("emdash:open-media-picker", handler);
		return () => document.removeEventListener("emdash:open-media-picker", handler);
	}, []);

	// Slash menu state — use ref to avoid re-creating the extension on state change
	const [slashMenuState, setSlashMenuState] = React.useState<SlashMenuState>(initialSlashMenuState);
	const slashMenuStateRef = React.useRef(slashMenuState);
	slashMenuStateRef.current = slashMenuState;

	const filterCommandsRef = React.useRef((query: string): SlashCommandItem[] => {
		const q = query.toLowerCase();
		return slashCommands.filter(
			(cmd) =>
				cmd.title.toLowerCase().includes(q) ||
				cmd.description.toLowerCase().includes(q) ||
				cmd.aliases?.some((a) => a.toLowerCase().includes(q)),
		);
	});

	const initialContent = React.useMemo(
		() => portableTextToPM(value || []),
		[], // Only compute once on mount
	);

	const getBlocks = React.useCallback((): PTBlock[] => {
		const editor = editorRef.current;
		if (!editor) return initialRef.current;
		const json: unknown = editor.getJSON();
		if (!isPMNode(json)) return initialRef.current;
		return pmToPortableText(json);
	}, []);

	const save = React.useCallback(async () => {
		if (savingRef.current) return;

		const current = JSON.stringify(getBlocks());
		const initial = JSON.stringify(initialRef.current);
		if (current === initial) return;

		savingRef.current = true;
		try {
			const res = await fetch(
				`/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}`,
				{
					method: "PUT",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
					body: JSON.stringify({ data: { [field]: getBlocks() } }),
				},
			);

			if (res.ok) {
				initialRef.current = getBlocks();
				document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "saved" } }));
				document.dispatchEvent(
					new CustomEvent("emdash:content-changed", {
						detail: { collection, id: entryId },
					}),
				);
			} else {
				document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
				console.error("Save failed:", res.status);
			}
		} catch (err) {
			document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
			console.error("Save failed:", err);
		} finally {
			savingRef.current = false;
		}
	}, [collection, entryId, field, getBlocks]);

	// Create slash commands extension once — uses refs to avoid re-render loop
	const slashCommandsExtension = React.useMemo(
		() =>
			createSlashCommandsExtension({
				filterCommands: (query: string) => filterCommandsRef.current(query),
				onStateChange: setSlashMenuState,
				getState: () => slashMenuStateRef.current,
			}),
		[],
	);

	const editor = useEditor({
		extensions: [
			StarterKit.configure({
				heading: { levels: [1, 2, 3] },
				dropcursor: { color: "#3b82f6", width: 2 },
			}),
			InlineBlockStyleExtension,
			InlineCssClassMark,
			Image.extend({
				addAttributes() {
					return {
						...this.parent?.(),
						mediaId: { default: null },
						provider: { default: null },
						width: { default: null },
						height: { default: null },
					};
				},
			}),
			Underline,
			Link.configure({
				openOnClick: false,
				HTMLAttributes: { class: "underline text-blue-600 dark:text-blue-400" },
			}),
			Placeholder.configure({
				includeChildren: true,
				placeholder: ({ node }) => {
					if (node.type.name === "paragraph") return "Type / for commands...";
					return "";
				},
			}),
			TextAlign.configure({
				types: ["heading", "paragraph"],
			}),
			Focus.configure({
				className: "has-focus",
				mode: "all",
			}),
			Typography,
			slashCommandsExtension,
		],
		content: initialContent,
		immediatelyRender: false,
		editorProps: {
			attributes: {
				class: "prose prose-sm sm:prose-base dark:prose-invert max-w-none emdash-inline-editor",
			},
		},
		onUpdate: () => {
			document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "unsaved" } }));
		},
	});

	// Store editor ref for getBlocks
	React.useEffect(() => {
		editorRef.current = editor;
	}, [editor]);

	// Slash menu command handler
	const handleSlashCommand = React.useCallback(
		(item: SlashCommandItem) => {
			if (!editor || !slashMenuStateRef.current.range) return;
			item.command({ editor, range: slashMenuStateRef.current.range });
			setSlashMenuState((prev) => ({ ...prev, isOpen: false }));
		},
		[editor],
	);

	// Handle media selection from the picker
	const handleMediaSelect = React.useCallback(
		(item: MediaItemData) => {
			if (!editor) return;
			const src =
				item.url || item.previewUrl || `/_emdash/api/media/file/${item.storageKey || item.id}`;
			editor
				.chain()
				.focus()
				.setImage({
					src,
					alt: item.alt || item.filename || "",
					mediaId: item.id,
					width: item.width,
					height: item.height,
				})
				.run();
			setMediaPickerOpen(false);
			void save();
		},
		[editor, save],
	);

	// Save on blur — but not when interacting with slash menu or media picker
	const handleBlur = React.useCallback(
		(e: React.FocusEvent<HTMLDivElement>) => {
			if (mediaPickerOpen) return;
			const related = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
			if (related && e.currentTarget.contains(related)) return;
			// Don't save if focus moved to the slash menu (portalled to body)
			if (related?.closest(".emdash-slash-menu")) return;
			if (related?.closest(".emdash-media-picker")) return;
			save();
		},
		[save, mediaPickerOpen],
	);

	if (!editor) return null;

	return (
		<div onBlur={handleBlur}>
			<InlineBubbleMenu editor={editor} />
			<EditorContent editor={editor} />
			<InlineSlashMenu
				state={slashMenuState}
				onCommand={handleSlashCommand}
				setSelectedIndex={(index) =>
					setSlashMenuState((prev) => ({ ...prev, selectedIndex: index }))
				}
			/>
			<InlineMediaPicker
				open={mediaPickerOpen}
				onClose={() => {
					setMediaPickerOpen(false);
					editor?.commands.focus();
				}}
				onSelect={handleMediaSelect}
			/>
			<style>{`
				.emdash-bubble-menu {
					z-index: 100;
					display: flex;
					align-items: center;
					gap: 2px;
					padding: 4px;
					border-radius: 8px;
					border: 1px solid #d1d5db;
					background: white;
					box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
				}
				.emdash-bubble-btn {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					width: 32px;
					height: 32px;
					border-radius: 6px;
					border: none;
					background: transparent;
					cursor: pointer;
					color: inherit;
					font-size: 14px;
					line-height: 1;
					padding: 0;
				}
				.emdash-bubble-btn:hover {
					background: #f3f4f6;
				}
				.emdash-bubble-btn--active {
					background: #dbeafe;
					color: #1d4ed8;
				}
				.emdash-bubble-btn--active:hover {
					background: #bfdbfe;
				}
				.emdash-bubble-btn--danger {
					color: #dc2626;
				}
				.emdash-bubble-divider {
					display: block;
					width: 1px;
					height: 20px;
					background: #d1d5db;
					margin: 0 4px;
				}
				.emdash-bubble-link-input {
					height: 28px;
					width: 200px;
					font-size: 13px;
					padding: 0 8px;
					border: 1px solid #d1d5db;
					border-radius: 4px;
					outline: none;
					background: white;
					color: inherit;
					font-family: inherit;
				}
				.emdash-bubble-link-input:focus {
					border-color: #3b82f6;
				}
				@media (prefers-color-scheme: dark) {
					.emdash-bubble-menu {
						background: #1f2937;
						border-color: #374151;
						color: #e5e7eb;
					}
					.emdash-bubble-btn:hover {
						background: #374151;
					}
					.emdash-bubble-btn--active {
						background: #1e3a5f;
						color: #93c5fd;
					}
					.emdash-bubble-btn--active:hover {
						background: #1e40af;
					}
					.emdash-bubble-divider {
						background: #4b5563;
					}
					.emdash-bubble-link-input {
						background: #111827;
						border-color: #4b5563;
						color: #e5e7eb;
					}
					.emdash-bubble-link-input:focus {
						border-color: #60a5fa;
					}
					.emdash-slash-menu {
						background: #1f2937 !important;
						border-color: #374151 !important;
						color: #e5e7eb !important;
					}
					.emdash-slash-menu button:hover,
					.emdash-slash-menu button[style*="background: rgb(243, 244, 246)"] {
						background: #374151 !important;
					}
					.emdash-media-picker {
						background: #1f2937 !important;
						color: #e5e7eb !important;
					}
					.emdash-media-picker button {
						color: #e5e7eb !important;
					}
				}
				.emdash-inline-editor:focus {
					outline: none;
				}
			`}</style>
		</div>
	);
}
