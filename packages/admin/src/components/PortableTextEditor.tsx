/**
 * Portable Text Editor
 *
 * TipTap-based rich text editor that stores content as Portable Text.
 * Handles conversion between ProseMirror JSON and Portable Text automatically.
 *
 * Features:
 * - BubbleMenu for inline formatting
 * - Link popover for editing URLs (no window.prompt)
 * - Slash commands for block insertion
 * - Floating menu on empty lines
 */

import { Button, Dialog, Input } from "@cloudflare/kumo";
import type { Element } from "@emdash-cms/blocks";
import { useFloating, offset, flip, shift, autoUpdate } from "@floating-ui/react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	TextB,
	TextItalic,
	TextUnderline,
	TextStrikethrough,
	Code,
	TextHOne,
	TextHTwo,
	TextHThree,
	List,
	ListNumbers,
	Quotes,
	Link as LinkIcon,
	Image as ImageIcon,
	ArrowUUpLeft,
	ArrowUUpRight,
	TextAlignLeft,
	TextAlignCenter,
	TextAlignRight,
	Minus,
	LinkBreak,
	ArrowSquareOut,
	CodeBlock,
	Stack,
	Eye,
	type Icon,
} from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { Extension, type Range } from "@tiptap/core";
import CharacterCount from "@tiptap/extension-character-count";
import Focus from "@tiptap/extension-focus";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import { useEditor, EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Suggestion from "@tiptap/suggestion";
import * as React from "react";
import { createPortal } from "react-dom";

import type { EditorStyleEntry, MediaItem } from "../lib/api";
import type { Section } from "../lib/api";
import { cn } from "../lib/utils";
import { BlockStyleExtension } from "./editor/BlockStyleExtension";
import { CssClassMark } from "./editor/CssClassMark";
import { DragHandleWrapper } from "./editor/DragHandleWrapper";
import { EditorStyleToolbar } from "./editor/EditorStyleToolbar";
import { ImageExtension } from "./editor/ImageNode";
import { MarkdownLinkExtension } from "./editor/MarkdownLinkExtension";
import {
	type PluginBlockDef,
	PluginBlockExtension,
	registerPluginBlocks,
	resolveIcon,
} from "./editor/PluginBlockNode";
import { MediaPickerModal } from "./MediaPickerModal";
import { SectionPickerModal } from "./SectionPickerModal";

// Import converters from inline module since we can't import from emdash package
// These will be duplicated here until we set up proper package exports

interface PortableTextSpan {
	_type: "span";
	_key: string;
	text: string;
	marks?: string[];
}

interface PortableTextMarkDef {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

interface PortableTextTextBlock {
	_type: "block";
	_key: string;
	style?: "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote";
	listItem?: "bullet" | "number";
	level?: number;
	children: PortableTextSpan[];
	markDefs?: PortableTextMarkDef[];
	cssClasses?: string;
}

interface PortableTextImageBlock {
	_type: "image";
	_key: string;
	asset: { _ref: string; url?: string };
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
	displayWidth?: number;
	displayHeight?: number;
}

interface PortableTextCodeBlock {
	_type: "code";
	_key: string;
	code: string;
	language?: string;
}

type PortableTextBlock =
	| PortableTextTextBlock
	| PortableTextImageBlock
	| PortableTextCodeBlock
	| { _type: string; _key: string; [key: string]: unknown };

// Generate unique key
function generateKey(): string {
	return Math.random().toString(36).substring(2, 11);
}

// Helpers for safely extracting typed values from ProseMirror attrs (Record<string, any>)
const attrStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const attrNum = (v: unknown): number | undefined => (typeof v === "number" && v ? v : undefined);

// ProseMirror to Portable Text converter
function prosemirrorToPortableText(doc: {
	type: string;
	content?: Array<{
		type: string;
		attrs?: Record<string, unknown>;
		content?: unknown[];
		marks?: unknown[];
		text?: string;
	}>;
}): PortableTextBlock[] {
	if (!doc || doc.type !== "doc" || !doc.content) {
		return [];
	}

	const blocks: PortableTextBlock[] = [];

	for (const node of doc.content) {
		const converted = convertPMNode(node);
		if (converted) {
			if (Array.isArray(converted)) {
				blocks.push(...converted);
			} else {
				blocks.push(converted);
			}
		}
	}

	return blocks;
}

const CSS_WHITESPACE_RE = /\s+/;

function normalizeClassTokens(value: string | undefined): string[] {
	if (!value) return [];
	return value.trim().split(CSS_WHITESPACE_RE).filter(Boolean);
}

function mergeCssClassTokens(a: string | undefined, b: string | undefined): string | undefined {
	const aTokens = normalizeClassTokens(a);
	const bTokens = normalizeClassTokens(b);
	if (aTokens.length === 0) return bTokens.length > 0 ? bTokens.join(" ") : undefined;
	if (bTokens.length === 0) return aTokens.join(" ");
	const set = new Set<string>([...aTokens, ...bTokens]);
	return set.size > 0 ? [...set].join(" ") : undefined;
}

function readCssClassesAttr(obj: unknown): string | undefined {
	if (typeof obj !== "object" || obj === null) return undefined;
	const v = (obj as Record<string, unknown>).cssClasses;
	return typeof v === "string" ? v : undefined;
}

function convertPMNode(node: {
	type: string;
	attrs?: Record<string, unknown>;
	content?: unknown[];
	marks?: unknown[];
	text?: string;
}): PortableTextBlock | PortableTextBlock[] | null {
	const result = convertPMNodeInner(node);
	// Merge cssClasses from this node with whatever the inner conversion already
	// produced (e.g., paragraph cssClasses inside a styled blockquote).
	if (!result) return null;
	const outer = readCssClassesAttr(node.attrs);
	if (!outer) return result;

	const merge = (b: PortableTextBlock): PortableTextBlock => {
		const inner = readCssClassesAttr(b);
		const merged = mergeCssClassTokens(outer, inner);
		return merged ? ({ ...b, cssClasses: merged } as PortableTextBlock) : b;
	};

	if (Array.isArray(result)) {
		return result.map(merge);
	}
	return merge(result);
}

function convertPMNodeInner(node: {
	type: string;
	attrs?: Record<string, unknown>;
	content?: unknown[];
	marks?: unknown[];
	text?: string;
}): PortableTextBlock | PortableTextBlock[] | null {
	switch (node.type) {
		case "paragraph": {
			const { children, markDefs } = convertInlineContent(node.content || []);
			if (children.length === 0) return null;
			return {
				_type: "block",
				_key: generateKey(),
				style: "normal",
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			};
		}

		case "heading": {
			const { children, markDefs } = convertInlineContent(node.content || []);
			const rawLevel = node.attrs?.level;
			const level = typeof rawLevel === "number" ? rawLevel : 1;
			if (children.length === 0) return null;
			const headingStyle =
				level >= 1 && level <= 6
					? (`h${level}` as PortableTextTextBlock["style"])
					: ("h1" as PortableTextTextBlock["style"]);
			return {
				_type: "block",
				_key: generateKey(),
				style: headingStyle,
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			};
		}

		case "bulletList":
			return convertList(node.content || [], "bullet");

		case "orderedList":
			return convertList(node.content || [], "number");

		case "blockquote": {
			const blocks: PortableTextTextBlock[] = [];
			const blockquoteContent = (node.content || []) as Array<{
				type: string;
				attrs?: Record<string, unknown>;
				content?: unknown[];
			}>;
			for (const child of blockquoteContent) {
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInlineContent(child.content || []);
					if (children.length > 0) {
						const innerClasses =
							typeof child.attrs?.cssClasses === "string" ? child.attrs.cssClasses : undefined;
						const block: PortableTextTextBlock = {
							_type: "block",
							_key: generateKey(),
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
				return blocks[0]!;
			}
			return blocks.length > 0 ? blocks : null;
		}

		case "codeBlock": {
			const codeContent = (node.content || []) as Array<{ text?: string }>;
			const code = codeContent.map((n) => n.text || "").join("");
			const rawLanguage = node.attrs?.language;
			return {
				_type: "code",
				_key: generateKey(),
				code,
				language: typeof rawLanguage === "string" ? rawLanguage : undefined,
			};
		}

		case "image": {
			const attrs = node.attrs ?? {};
			const provider = attrStr(attrs.provider);
			return {
				_type: "image",
				_key: generateKey(),
				asset: {
					_ref: attrStr(attrs.mediaId) ?? "",
					url: attrStr(attrs.src) ?? "",
					provider: provider && provider !== "local" ? provider : undefined,
				},
				alt: attrStr(attrs.alt),
				caption: attrStr(attrs.caption) ?? attrStr(attrs.title),
				width: attrNum(attrs.width),
				height: attrNum(attrs.height),
				displayWidth: attrNum(attrs.displayWidth),
				displayHeight: attrNum(attrs.displayHeight),
			};
		}

		case "horizontalRule": {
			const hrVariant = typeof node.attrs?.variant === "string" ? node.attrs.variant : undefined;
			return {
				_type: "break",
				_key: generateKey(),
				style: "lineBreak",
				...(hrVariant ? { variant: hrVariant } : {}),
			};
		}

		case "pluginBlock": {
			const { blockType, id: pluginId, data } = node.attrs ?? {};
			return {
				...(data && typeof data === "object" ? data : {}),
				_type: typeof blockType === "string" ? blockType : "embed",
				_key: generateKey(),
				id: typeof pluginId === "string" ? pluginId : "",
			};
		}

		default:
			return null;
	}
}

function convertList(items: unknown[], listItem: "bullet" | "number"): PortableTextTextBlock[] {
	const blocks: PortableTextTextBlock[] = [];
	const typedItems = items as Array<{
		type: string;
		attrs?: Record<string, unknown>;
		content?: unknown[];
	}>;

	for (const item of typedItems) {
		if (item.type === "listItem") {
			const itemClasses =
				typeof item.attrs?.cssClasses === "string" ? item.attrs.cssClasses : undefined;
			const listItemContent = (item.content || []) as Array<{
				type: string;
				attrs?: Record<string, unknown>;
				content?: unknown[];
			}>;
			for (const child of listItemContent) {
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInlineContent(child.content || []);
					if (children.length > 0) {
						const paraClasses =
							typeof child.attrs?.cssClasses === "string" ? child.attrs.cssClasses : undefined;
						const merged = mergeCssClassTokens(itemClasses, paraClasses);
						const block: PortableTextTextBlock = {
							_type: "block",
							_key: generateKey(),
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

function convertInlineContent(nodes: unknown[]): {
	children: PortableTextSpan[];
	markDefs: PortableTextMarkDef[];
} {
	const children: PortableTextSpan[] = [];
	const markDefs: PortableTextMarkDef[] = [];
	// Dedupe map keyed by namespaced strings: `link:${href}` for link marks,
	// `cssClass:${classes}` for cssClass marks. Namespacing prevents a link
	// whose href happens to start with `cssClass:` from colliding with a
	// cssClass entry.
	const markDefMap = new Map<string, string>();

	const typedNodes = nodes as Array<{
		type: string;
		text?: string;
		marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
	}>;
	for (const node of typedNodes) {
		if (node.type === "text" && node.text) {
			const marks: string[] = [];

			for (const mark of node.marks || []) {
				const markType = convertMark(mark, markDefs, markDefMap);
				if (markType) {
					marks.push(markType);
				}
			}

			children.push({
				_type: "span",
				_key: generateKey(),
				text: node.text,
				marks: marks.length > 0 ? marks : undefined,
			});
		} else if (node.type === "hardBreak") {
			if (children.length > 0) {
				const last = children.at(-1);
				if (last) last.text += "\n";
			} else {
				children.push({
					_type: "span",
					_key: generateKey(),
					text: "\n",
				});
			}
		}
	}

	if (children.length === 0) {
		children.push({
			_type: "span",
			_key: generateKey(),
			text: "",
		});
	}

	return { children, markDefs };
}

function convertMark(
	mark: { type: string; attrs?: Record<string, unknown> },
	markDefs: PortableTextMarkDef[],
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
			const rawHref = mark.attrs?.href;
			const href = typeof rawHref === "string" ? rawHref : "";
			const dedupeKey = `link:${href}`;
			if (markDefMap.has(dedupeKey)) {
				return markDefMap.get(dedupeKey)!;
			}
			const key = generateKey();
			markDefs.push({
				_type: "link",
				_key: key,
				href,
				blank: mark.attrs?.target === "_blank",
			});
			markDefMap.set(dedupeKey, key);
			return key;
		}
		case "cssClass": {
			const raw = typeof mark.attrs?.classes === "string" ? mark.attrs.classes : "";
			const classes = raw.trim();
			if (!classes) return null;
			const dedupeKey = `cssClass:${classes}`;
			if (markDefMap.has(dedupeKey)) {
				return markDefMap.get(dedupeKey)!;
			}
			const key = generateKey();
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

// Type guards for PortableText block variants
function isTextBlock(block: PortableTextBlock): block is PortableTextTextBlock {
	return block._type === "block";
}

function isImageBlock(block: PortableTextBlock): block is PortableTextImageBlock {
	return block._type === "image";
}

function isCodeBlock(block: PortableTextBlock): block is PortableTextCodeBlock {
	return block._type === "code";
}

// Portable Text to ProseMirror converter
function portableTextToProsemirror(blocks: PortableTextBlock[]): {
	type: "doc";
	content: unknown[];
} {
	if (!blocks || blocks.length === 0) {
		return {
			type: "doc",
			content: [{ type: "paragraph" }],
		};
	}

	const content: unknown[] = [];
	let i = 0;

	while (i < blocks.length) {
		const block = blocks[i]!;

		if (isTextBlock(block) && block.listItem) {
			const listBlocks: PortableTextTextBlock[] = [];
			const listType = block.listItem;

			while (i < blocks.length) {
				const current = blocks[i]!;
				if (isTextBlock(current) && current.listItem === listType) {
					listBlocks.push(current);
					i++;
				} else {
					break;
				}
			}

			content.push(convertPTList(listBlocks, listType));
		} else {
			const converted = convertPTBlock(block);
			if (converted) {
				content.push(converted);
			}
			i++;
		}
	}

	return {
		type: "doc",
		content: content.length > 0 ? content : [{ type: "paragraph" }],
	};
}

function convertPTBlock(block: PortableTextBlock): unknown {
	const node = convertPTBlockInner(block);
	if (!node || typeof node !== "object") return node;
	const raw = (block as Record<string, unknown>).cssClasses;
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed) return node;
	const n = node as Record<string, unknown>;
	return {
		...n,
		attrs: { ...(n.attrs as Record<string, unknown> | undefined), cssClasses: trimmed },
	};
}

function convertPTBlockInner(block: PortableTextBlock): unknown {
	switch (block._type) {
		case "block": {
			if (!isTextBlock(block)) return null;
			const { style = "normal", children, markDefs = [] } = block;
			const pmContent = convertPTSpans(children, markDefs);

			switch (style) {
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6": {
					const level = parseInt(style.substring(1), 10);
					return {
						type: "heading",
						attrs: { level },
						content: pmContent.length > 0 ? pmContent : undefined,
					};
				}
				case "blockquote":
					return {
						type: "blockquote",
						content: [
							{
								type: "paragraph",
								content: pmContent.length > 0 ? pmContent : undefined,
							},
						],
					};
				default:
					return {
						type: "paragraph",
						content: pmContent.length > 0 ? pmContent : undefined,
					};
			}
		}

		case "image": {
			if (!isImageBlock(block)) return null;
			const imageBlock = block;
			return {
				type: "image",
				attrs: {
					src: imageBlock.asset.url || `/_emdash/api/media/file/${imageBlock.asset._ref}`,
					alt: imageBlock.alt || "",
					title: imageBlock.caption || "",
					caption: imageBlock.caption || "",
					mediaId: imageBlock.asset._ref,
					width: imageBlock.width,
					height: imageBlock.height,
					displayWidth: imageBlock.displayWidth,
					displayHeight: imageBlock.displayHeight,
				},
			};
		}

		case "code": {
			if (!isCodeBlock(block)) return null;
			const codeBlock = block;
			return {
				type: "codeBlock",
				attrs: { language: codeBlock.language || null },
				content: codeBlock.code ? [{ type: "text", text: codeBlock.code }] : undefined,
			};
		}

		case "break": {
			const variant = (block as { variant?: unknown }).variant;
			return {
				type: "horizontalRule",
				attrs: typeof variant === "string" ? { variant } : undefined,
			};
		}

		default: {
			// Treat unknown block types as plugin blocks (embeds)
			// These have an id field (or url for backwards compat) for the embed source,
			// OR Block Kit field data stored as top-level keys (e.g., formId for forms plugin)
			const { _type, _key, id, url, ...rest } = block as Record<string, unknown>;
			// Filter out _-prefixed keys to prevent accumulation across edit cycles
			const data = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("_")));
			const hasFieldData = Object.keys(data).length > 0;
			if (id || url || hasFieldData) {
				return {
					type: "pluginBlock",
					attrs: {
						blockType: _type,
						id: id || url || "",
						data,
					},
				};
			}
			// Truly unknown blocks with no data at all
			return {
				type: "paragraph",
				content: [
					{
						type: "text",
						text: `[Unknown block type: ${block._type}]`,
						marks: [{ type: "code" }],
					},
				],
			};
		}
	}
}

function convertPTList(items: PortableTextTextBlock[], listType: "bullet" | "number"): unknown {
	const listItems = items.map((item) => {
		const pmContent = convertPTSpans(item.children, item.markDefs || []);
		const rawClasses = (item as { cssClasses?: unknown }).cssClasses;
		const cssClasses =
			typeof rawClasses === "string" && rawClasses.trim().length > 0
				? rawClasses.trim()
				: undefined;
		const node: { type: "listItem"; content: unknown[]; attrs?: { cssClasses: string } } = {
			type: "listItem",
			content: [
				{
					type: "paragraph",
					content: pmContent.length > 0 ? pmContent : undefined,
				},
			],
		};
		if (cssClasses) {
			node.attrs = { cssClasses };
		}
		return node;
	});

	return {
		type: listType === "bullet" ? "bulletList" : "orderedList",
		content: listItems,
	};
}

function convertPTSpans(spans: PortableTextSpan[], markDefs: PortableTextMarkDef[]): unknown[] {
	const nodes: unknown[] = [];
	const markDefsMap = new Map(markDefs.map((md) => [md._key, md]));

	for (const span of spans) {
		if (span._type !== "span") continue;

		const parts = span.text.split("\n");

		for (let i = 0; i < parts.length; i++) {
			const text = parts[i]!;

			if (text.length > 0) {
				const marks = convertPTMarks(span.marks || [], markDefsMap);
				const node: { type: string; text: string; marks?: unknown[] } = {
					type: "text",
					text,
				};
				if (marks.length > 0) {
					node.marks = marks;
				}
				nodes.push(node);
			}

			if (i < parts.length - 1) {
				nodes.push({ type: "hardBreak" });
			}
		}
	}

	return nodes;
}

function convertPTMarks(marks: string[], markDefs: Map<string, PortableTextMarkDef>): unknown[] {
	const pmMarks: unknown[] = [];

	for (const mark of marks) {
		switch (mark) {
			case "strong":
				pmMarks.push({ type: "bold" });
				break;
			case "em":
				pmMarks.push({ type: "italic" });
				break;
			case "underline":
				pmMarks.push({ type: "underline" });
				break;
			case "strike-through":
				pmMarks.push({ type: "strike" });
				break;
			case "code":
				pmMarks.push({ type: "code" });
				break;
			default: {
				const markDef = markDefs.get(mark);
				if (markDef) {
					if (markDef._type === "link") {
						pmMarks.push({
							type: "link",
							attrs: {
								href: markDef.href,
								target: markDef.blank ? "_blank" : null,
							},
						});
					} else if (markDef._type === "cssClass") {
						const raw = (markDef as { classes?: unknown }).classes;
						const classes = typeof raw === "string" ? raw.trim() : "";
						if (classes) {
							pmMarks.push({
								type: "cssClass",
								attrs: { classes },
							});
						}
					}
				}
				break;
			}
		}
	}

	return pmMarks;
}

// =============================================================================
// Slash Commands
// =============================================================================

/**
 * Slash command item definition
 */
interface SlashCommandItem {
	id: string;
	/** Built-in commands use `msg`; plugin/API-sourced titles stay plain `string`. */
	title: MessageDescriptor | string;
	description: MessageDescriptor | string;
	icon: Icon | React.ComponentType<{ className?: string }>;
	command: (props: { editor: Editor; range: Range }) => void;
	aliases?: string[];
	category?: MessageDescriptor;
}

/**
 * Default slash commands for built-in block types
 */
const defaultSlashCommands: SlashCommandItem[] = [
	{
		id: "heading1",
		title: msg`Heading 1`,
		description: msg`Large section heading`,
		icon: TextHOne,
		aliases: ["h1", "title"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run();
		},
	},
	{
		id: "heading2",
		title: msg`Heading 2`,
		description: msg`Medium section heading`,
		icon: TextHTwo,
		aliases: ["h2", "subtitle"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run();
		},
	},
	{
		id: "heading3",
		title: msg`Heading 3`,
		description: msg`Small section heading`,
		icon: TextHThree,
		aliases: ["h3"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run();
		},
	},
	{
		id: "bulletList",
		title: msg`Bullet List`,
		description: msg`Create a bullet list`,
		icon: List,
		aliases: ["ul", "unordered"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleBulletList().run();
		},
	},
	{
		id: "numberedList",
		title: msg`Numbered List`,
		description: msg`Create a numbered list`,
		icon: ListNumbers,
		aliases: ["ol", "ordered"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleOrderedList().run();
		},
	},
	{
		id: "quote",
		title: msg`Quote`,
		description: msg`Insert a blockquote`,
		icon: Quotes,
		aliases: ["blockquote", "cite"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleBlockquote().run();
		},
	},
	{
		id: "codeBlock",
		title: msg`Code Block`,
		description: msg`Insert a code block`,
		icon: CodeBlock,
		aliases: ["code", "pre", "```"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
		},
	},
	{
		id: "divider",
		title: msg`Divider`,
		description: msg`Insert a horizontal rule`,
		icon: Minus,
		aliases: ["hr", "---", "separator"],
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setHorizontalRule().run();
		},
	},
];

/**
 * Slash menu state
 */
interface SlashMenuState {
	isOpen: boolean;
	items: SlashCommandItem[];
	selectedIndex: number;
	clientRect: (() => DOMRect | null) | null;
	range: Range | null;
}

/**
 * Create the slash commands TipTap extension
 */
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
						const item = props as SlashCommandItem;
						item.command({ editor, range });
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

/**
 * Slash command menu component using Floating UI
 */
function SlashCommandMenu({
	state,
	onCommand,
	onClose: _onClose,
	setSelectedIndex,
}: {
	state: SlashMenuState;
	onCommand: (item: SlashCommandItem) => void;
	onClose: () => void;
	setSelectedIndex: (index: number) => void;
}) {
	const { t } = useLingui();
	const containerRef = React.useRef<HTMLDivElement>(null);

	const { refs, floatingStyles } = useFloating({
		open: state.isOpen,
		placement: "bottom-start",
		middleware: [offset(8), flip(), shift({ padding: 8 })],
		whileElementsMounted: autoUpdate,
	});

	// Sync virtual reference from TipTap's clientRect
	React.useEffect(() => {
		if (state.clientRect) {
			const clientRectFn = state.clientRect;
			refs.setReference({
				getBoundingClientRect: () => clientRectFn() ?? new DOMRect(),
			});
		}
	}, [state.clientRect, refs]);

	// Scroll selected item into view
	React.useEffect(() => {
		if (!state.isOpen) return;
		const container = containerRef.current;
		if (!container) return;

		const selected = container.querySelector<HTMLElement>(`[data-index="${state.selectedIndex}"]`);
		if (selected) {
			selected.scrollIntoView({ block: "nearest" });
		}
	}, [state.selectedIndex, state.isOpen]);

	if (!state.isOpen) return null;

	return createPortal(
		<div
			ref={(node) => {
				containerRef.current = node;
				refs.setFloating(node);
			}}
			style={floatingStyles}
			className="z-[100] rounded-lg border bg-kumo-overlay p-1 shadow-lg min-w-[220px] max-h-[300px] overflow-y-auto"
		>
			{state.items.length === 0 ? (
				<p className="text-sm text-kumo-subtle px-3 py-2">{t`No results`}</p>
			) : (
				state.items.map((item, index) => (
					<button
						key={item.id}
						type="button"
						data-index={index}
						className={cn(
							"flex items-center gap-3 w-full px-3 py-2 text-sm rounded text-left",
							index === state.selectedIndex
								? "bg-kumo-tint text-kumo-default"
								: "hover:bg-kumo-tint/50",
						)}
						onClick={() => onCommand(item)}
						onMouseEnter={() => setSelectedIndex(index)}
					>
						<item.icon className="h-4 w-4 text-kumo-subtle flex-shrink-0" />
						<div className="flex flex-col">
							<span className="font-medium">
								{typeof item.title === "string" ? item.title : t(item.title)}
							</span>
							<span className="text-xs text-kumo-subtle">
								{typeof item.description === "string" ? item.description : t(item.description)}
							</span>
						</div>
					</button>
				))
			)}
		</div>,
		document.body,
	);
}

/**
 * Plugin block insertion/editing modal.
 * When the block has `fields`, renders Block Kit elements.
 * Otherwise falls back to a simple URL input.
 */
function PluginBlockModal({
	block,
	initialValues,
	onClose,
	onInsert,
}: {
	block: PluginBlockDef | null;
	/** Pre-populated values when editing an existing block */
	initialValues?: Record<string, unknown>;
	onClose: () => void;
	onInsert: (values: Record<string, unknown>) => void;
}) {
	const [formValues, setFormValues] = React.useState<Record<string, unknown>>({});
	const inputRef = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		if (block) {
			if (initialValues) {
				setFormValues({ ...initialValues });
			} else {
				setFormValues({});
			}
			if (!block.fields || block.fields.length === 0) {
				setTimeout(() => inputRef.current?.focus(), 0);
			}
		}
	}, [block, initialValues]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (block?.fields && block.fields.length > 0) {
			onInsert(formValues);
		} else {
			const url = typeof formValues.id === "string" ? formValues.id.trim() : "";
			if (url) {
				onInsert({ id: url });
			}
		}
	};

	const handleFieldChange = (actionId: string, value: unknown) => {
		setFormValues((prev) => ({ ...prev, [actionId]: value }));
	};

	const isEditing = !!initialValues;
	const hasFields = block?.fields && block.fields.length > 0;

	// For simple URL mode, check if the URL is non-empty
	// For Block Kit fields, require at least one field to have a value
	const canSubmit = hasFields
		? Object.values(formValues).some((v) => v !== undefined && v !== null && v !== "")
		: typeof formValues.id === "string" && formValues.id.trim().length > 0;

	return (
		<Dialog.Root open={!!block} onOpenChange={(open: boolean) => !open && onClose()}>
			<Dialog className="p-6" size="sm">
				<div className="flex items-start justify-between gap-4 mb-4">
					<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
						{isEditing ? "Edit" : "Insert"} {block?.label || ""}
					</Dialog.Title>
					<Dialog.Close
						aria-label="Close"
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label="Close"
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">Close</span>
							</Button>
						)}
					/>
				</div>
				<form onSubmit={handleSubmit}>
					<div className="py-4 space-y-4">
						{hasFields ? (
							block.fields!.map((field) => (
								<BlockKitField
									key={field.action_id}
									field={field}
									pluginId={block.pluginId}
									value={formValues[field.action_id]}
									onChange={handleFieldChange}
								/>
							))
						) : (
							<Input
								ref={inputRef}
								type="url"
								placeholder={block?.placeholder || "Enter URL..."}
								value={typeof formValues.id === "string" ? formValues.id : ""}
								onChange={(e) => handleFieldChange("id", e.target.value)}
							/>
						)}
					</div>
					<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!canSubmit}>
							{isEditing ? "Save" : "Insert"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * Renders a single Block Kit field element.
 * Supports text_input, number_input, select (with optional async options), and toggle.
 */
function BlockKitField({
	field,
	pluginId,
	value,
	onChange,
}: {
	field: Element;
	pluginId?: string;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}) {
	switch (field.type) {
		case "text_input": {
			const multiline = !!field.multiline;
			const placeholder = typeof field.placeholder === "string" ? field.placeholder : undefined;
			const Tag = multiline ? "textarea" : "input";
			return (
				<div>
					<label className="text-sm font-medium mb-1.5 block">{field.label}</label>
					{multiline ? (
						<Tag
							className="flex w-full rounded-md border border-kumo-line bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-kumo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 min-h-[80px]"
							placeholder={placeholder}
							value={typeof value === "string" ? value : ""}
							onChange={(e) => onChange(field.action_id, e.target.value)}
						/>
					) : (
						<Input
							type="text"
							placeholder={placeholder}
							value={typeof value === "string" ? value : ""}
							onChange={(e) => onChange(field.action_id, e.target.value)}
						/>
					)}
				</div>
			);
		}
		case "number_input": {
			const min = typeof field.min === "number" ? field.min : undefined;
			const max = typeof field.max === "number" ? field.max : undefined;
			return (
				<div>
					<label className="text-sm font-medium mb-1.5 block">{field.label}</label>
					<Input
						type="number"
						min={min}
						max={max}
						value={typeof value === "number" ? String(value) : ""}
						onChange={(e) =>
							onChange(field.action_id, e.target.value ? Number(e.target.value) : undefined)
						}
					/>
				</div>
			);
		}
		case "select": {
			return <DynamicSelect field={field} pluginId={pluginId} value={value} onChange={onChange} />;
		}
		case "toggle": {
			return (
				<div className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={!!value}
						onChange={(e) => onChange(field.action_id, e.target.checked)}
						className="h-4 w-4"
					/>
					<label className="text-sm font-medium">{field.label}</label>
				</div>
			);
		}
		default:
			return <div className="text-sm text-kumo-subtle">Unknown field type: {field.type}</div>;
	}
}

/**
 * Select field that supports loading options dynamically via `optionsRoute`.
 * When `optionsRoute` is set, fetches `{ items: [{ id, name }] }` from the plugin route.
 */
function DynamicSelect({
	field,
	pluginId,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "select" }>;
	pluginId?: string;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}) {
	const [dynamicOptions, setDynamicOptions] = React.useState<Array<{
		label: string;
		value: string;
	}> | null>(null);
	const [loading, setLoading] = React.useState(false);

	React.useEffect(() => {
		if (!field.optionsRoute || !pluginId) return;
		const controller = new AbortController();
		setLoading(true);
		void (async () => {
			try {
				const res = await fetch(`/_emdash/api/plugins/${pluginId}/${field.optionsRoute}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-EmDash-Request": "1",
					},
					body: JSON.stringify({}),
					signal: controller.signal,
				});
				if (res.ok) {
					const body = (await res.json()) as {
						data: { items?: Array<{ id: string; name: string }> };
					};
					if (body.data?.items) {
						setDynamicOptions(
							body.data.items.map((item) => ({ label: item.name, value: item.id })),
						);
					}
				}
			} catch {
				// Failed to load options or aborted — static options will be used
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			}
		})();
		return () => controller.abort();
	}, [field.optionsRoute, pluginId]);

	const options = dynamicOptions ?? field.options;

	return (
		<div>
			<label className="text-sm font-medium mb-1.5 block">{field.label}</label>
			{loading ? (
				<div className="flex h-10 items-center px-3 text-sm text-kumo-subtle">Loading...</div>
			) : (
				<select
					className="flex h-10 w-full rounded-md border border-kumo-line bg-transparent px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2"
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(field.action_id, e.target.value)}
				>
					<option value="">Select...</option>
					{options.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>
			)}
		</div>
	);
}

// Re-export for consumers
export type { PluginBlockDef } from "./editor/PluginBlockNode";

// Exported for unit testing (pure functions, no React dependencies)
export { prosemirrorToPortableText as _prosemirrorToPortableText };
export { portableTextToProsemirror as _portableTextToProsemirror };

// =============================================================================
// Editor Footer with Writing Metrics
// =============================================================================

/**
 * Calculate reading time in minutes based on word count
 * Uses a standard reading speed of 200 words per minute
 */
export function calculateReadingTime(words: number): number {
	return Math.ceil(words / 200);
}

/**
 * Editor footer showing writing metrics (word count, character count, reading time)
 */
function EditorFooter({ editor }: { editor: Editor }) {
	const { words, characters } = useEditorState({
		editor,
		selector: (ctx) => {
			const storage: { words: () => number; characters: () => number } =
				ctx.editor.storage.characterCount;
			return {
				words: storage.words(),
				characters: storage.characters(),
			};
		},
	});

	const readingTime = calculateReadingTime(words);

	return (
		<div className="border-t px-4 py-2 flex items-center gap-4 text-xs text-kumo-subtle">
			<span>
				{words} {words === 1 ? "word" : "words"}
			</span>
			<span>
				{characters} {characters === 1 ? "character" : "characters"}
			</span>
			<span>{readingTime} min read</span>
		</div>
	);
}

/** Focus mode state for the editor */
export type FocusMode = "normal" | "spotlight";

/** Describes a block sidebar panel request from a node view */
export interface BlockSidebarPanel {
	type: string;
	attrs: Record<string, unknown>;
	onUpdate: (attrs: Record<string, unknown>) => void;
	onReplace: (attrs: Record<string, unknown>) => void;
	onDelete: () => void;
	onClose: () => void;
}

// Editor Props
export interface PortableTextEditorProps {
	value?: PortableTextBlock[];
	onChange?: (value: PortableTextBlock[]) => void;
	placeholder?: string;
	className?: string;
	editable?: boolean;
	/** ID of label element for accessibility */
	"aria-labelledby"?: string;
	/** Plugin blocks available for insertion via slash commands */
	pluginBlocks?: PluginBlockDef[];
	/** Focus mode - controlled from parent for distraction-free mode coordination */
	focusMode?: FocusMode;
	/** Callback when focus mode changes */
	onFocusModeChange?: (mode: FocusMode) => void;
	/** Callback to receive the editor instance for external integrations */
	onEditorReady?: (editor: Editor) => void;
	/** Minimal chrome - hides toolbar, border, footer (distraction-free mode) */
	minimal?: boolean;
	/** Callback when a block node requests sidebar space (e.g. image settings) */
	onBlockSidebarOpen?: (panel: BlockSidebarPanel) => void;
	/** Callback when a block node closes its sidebar */
	onBlockSidebarClose?: () => void;
	/** Editor toolbar styles — plugin-declared buttons and dropdowns for CSS class toggles */
	editorStyles?: EditorStyleEntry[];
}

/**
 * Portable Text Editor Component
 */
export function PortableTextEditor({
	value,
	onChange,
	placeholder = "Start writing...",
	className,
	editable = true,
	"aria-labelledby": ariaLabelledby,
	pluginBlocks = [],
	focusMode: controlledFocusMode,
	onFocusModeChange,
	onEditorReady,
	minimal = false,
	onBlockSidebarOpen,
	onBlockSidebarClose,
	editorStyles = [],
}: PortableTextEditorProps) {
	const { t } = useLingui();

	// Use a ref for onChange to avoid recreating the editor when the callback changes
	const onChangeRef = React.useRef(onChange);
	React.useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	// Focus mode state - support both controlled and uncontrolled modes
	const [internalFocusMode, setInternalFocusMode] = React.useState<FocusMode>("normal");
	const focusMode = controlledFocusMode ?? internalFocusMode;
	const setFocusMode = (mode: FocusMode) => {
		if (onFocusModeChange) {
			onFocusModeChange(mode);
		} else {
			setInternalFocusMode(mode);
		}
	};

	// Media picker state (for image insertion)
	const [mediaPickerOpen, setMediaPickerOpen] = React.useState(false);

	// Plugin block insertion/editing state
	const [pluginBlockModal, setPluginBlockModal] = React.useState<PluginBlockDef | null>(null);
	const [pluginBlockInitialValues, setPluginBlockInitialValues] = React.useState<
		Record<string, unknown> | undefined
	>(undefined);
	/** When editing an existing block, store the node position for updateAttributes */
	const editingBlockPosRef = React.useRef<number | null>(null);

	// Section picker state (for inserting sections)
	const [sectionPickerOpen, setSectionPickerOpen] = React.useState(false);

	// Slash commands state
	const [slashMenuState, setSlashMenuState] = React.useState<SlashMenuState>({
		isOpen: false,
		items: [],
		selectedIndex: 0,
		clientRect: null,
		range: null,
	});

	// Ref to access current state synchronously in keyboard handlers
	const slashMenuStateRef = React.useRef(slashMenuState);
	React.useEffect(() => {
		slashMenuStateRef.current = slashMenuState;
	}, [slashMenuState]);

	// Build slash commands
	const slashCommands = React.useMemo(() => {
		const cmds: SlashCommandItem[] = [...defaultSlashCommands];

		// Add image command
		cmds.push({
			id: "image",
			title: msg`Image`,
			description: msg`Insert an image`,
			icon: ImageIcon,
			aliases: ["img", "photo", "picture", "url"],
			category: msg`Media`,
			command: ({ editor, range }) => {
				editor.chain().focus().deleteRange(range).run();
				setMediaPickerOpen(true);
			},
		});

		// Add section command
		cmds.push({
			id: "section",
			title: msg`Section`,
			description: msg`Insert a reusable section`,
			icon: Stack,
			aliases: ["pattern", "block", "template"],
			category: msg`Content`,
			command: ({ editor, range }) => {
				editor.chain().focus().deleteRange(range).run();
				setSectionPickerOpen(true);
			},
		});

		// Add plugin block commands (API labels/descriptions: plain strings, not msg-wrapped)
		for (const block of pluginBlocks) {
			cmds.push({
				id: `plugin-${block.pluginId}-${block.type}`,
				title: block.label,
				description: block.description ?? t(msg`Embed a ${block.label}`),
				icon: resolveIcon(block.icon),
				aliases: [block.type],
				category: msg`Embeds`,
				command: ({ editor, range }) => {
					editor.chain().focus().deleteRange(range).run();
					setPluginBlockModal(block);
				},
			});
		}

		return cmds;
	}, [pluginBlocks, t]);

	// Filter commands by query — accessed via ref so the Suggestion plugin
	// (created once) always sees the latest command list without needing
	// the extension to be recreated.
	const filterCommandsRef = React.useRef((_q: string): SlashCommandItem[] => []);
	filterCommandsRef.current = (query: string) => {
		if (!query) return slashCommands;
		const searchText = query.toLowerCase();
		const titleMatches: SlashCommandItem[] = [];
		const otherMatches: SlashCommandItem[] = [];
		for (const item of slashCommands) {
			const titleStr = typeof item.title === "string" ? item.title : t(item.title);
			const descStr = typeof item.description === "string" ? item.description : t(item.description);
			if (titleStr.toLowerCase().includes(searchText)) {
				titleMatches.push(item);
			} else if (
				descStr.toLowerCase().includes(searchText) ||
				item.aliases?.some((alias) => alias.toLowerCase().includes(searchText))
			) {
				otherMatches.push(item);
			}
		}
		return [...titleMatches, ...otherMatches];
	};

	// Convert initial value to ProseMirror format
	const initialContent = React.useMemo(
		() => portableTextToProsemirror(value || []),
		[], // Only compute once on mount
	);

	// Memoize the entire extensions array so TipTap never diffs/replaces
	// plugins on re-render. The loop was: extension array changes → useEditor
	// calls setOptions → old Suggestion plugin destroyed → onExit fires
	// setSlashMenuState → re-render → new extension array → repeat.
	// All mutable state (filterCommands, onChange) is accessed via refs.
	const extensions = React.useMemo(
		() => [
			StarterKit.configure({
				heading: {
					levels: [1, 2, 3],
				},
				dropcursor: {
					color: "#3b82f6",
					width: 2,
				},
				// StarterKit v3 includes Link and Underline
				link: {
					openOnClick: false,
					enableClickSelection: true,
					HTMLAttributes: {
						class: "text-kumo-brand underline",
					},
				},
				underline: {},
			}),
			CssClassMark,
			BlockStyleExtension,
			ImageExtension,
			MarkdownLinkExtension,
			PluginBlockExtension,
			Placeholder.configure({
				includeChildren: true,
				placeholder: ({ node }) => {
					if (node.type.name === "paragraph") {
						return placeholder;
					}
					return placeholder;
				},
			}),
			TextAlign.configure({
				types: ["heading", "paragraph"],
			}),
			createSlashCommandsExtension({
				filterCommands: (query: string) => filterCommandsRef.current(query),
				onStateChange: setSlashMenuState,
				getState: () => slashMenuStateRef.current,
			}),
			CharacterCount,
			Focus.configure({
				className: "has-focus",
				mode: "all",
			}),
			Typography,
		],
		[], // Created once — all mutable state accessed via refs
	);

	// Stable editorProps reference — a new object every render would cause
	// compareOptions to call setOptions → updateState → plugin teardown →
	// Suggestion onExit → setSlashMenuState → re-render → infinite loop.
	const editorProps = React.useMemo(
		() => ({
			attributes: {
				class:
					"prose prose-sm sm:prose-base dark:prose-invert max-w-none focus:outline-none min-h-[200px] p-4",
			},
		}),
		[],
	);

	const editor = useEditor({
		extensions,
		content: initialContent as Parameters<typeof useEditor>[0]["content"],
		editable,
		immediatelyRender: true,
		editorProps,
		onUpdate: ({ editor: updatedEditor }) => {
			const cb = onChangeRef.current;
			if (cb) {
				const doc = updatedEditor.getJSON();
				// TipTap's getJSON() returns JSONContent which is structurally compatible
				const pmDoc = doc as Parameters<typeof prosemirrorToPortableText>[0];
				const portableText = prosemirrorToPortableText(pmDoc);
				cb(portableText);
			}
		},
	});

	// Notify when editor is ready
	React.useEffect(() => {
		if (editor && onEditorReady) {
			onEditorReady(editor);
		}
	}, [editor, onEditorReady]);

	// Register plugin blocks into editor storage so the node view can look up metadata
	React.useEffect(() => {
		if (editor) {
			registerPluginBlocks(
				editor as unknown as { storage: Record<string, Record<string, unknown>> },
				pluginBlocks,
			);
		}
	}, [editor, pluginBlocks]);

	// Wire up the onEditBlock callback so the node view can open the Block Kit modal
	React.useEffect(() => {
		if (!editor) return;
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>)
			.pluginBlock;
		if (!storage) return;
		storage.onEditBlock = (attrs: {
			blockType: string;
			id: string;
			data: Record<string, unknown>;
			pos: number;
		}) => {
			const blockDef = pluginBlocks.find((b) => b.type === attrs.blockType);
			if (!blockDef) return;
			editingBlockPosRef.current = attrs.pos;
			setPluginBlockInitialValues({ id: attrs.id, ...attrs.data });
			setPluginBlockModal(blockDef);
		};
		return () => {
			storage.onEditBlock = null;
		};
	}, [editor, pluginBlocks]);

	// Wire up block sidebar callbacks so node views (e.g. ImageNode) can request sidebar space
	const onBlockSidebarOpenRef = React.useRef(onBlockSidebarOpen);
	onBlockSidebarOpenRef.current = onBlockSidebarOpen;
	const onBlockSidebarCloseRef = React.useRef(onBlockSidebarClose);
	onBlockSidebarCloseRef.current = onBlockSidebarClose;

	React.useEffect(() => {
		if (!editor) return;
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).image;
		if (!storage) return;
		storage.onOpenBlockSidebar = (panel: BlockSidebarPanel) => {
			onBlockSidebarOpenRef.current?.(panel);
		};
		storage.onCloseBlockSidebar = () => {
			onBlockSidebarCloseRef.current?.();
		};
		return () => {
			storage.onOpenBlockSidebar = null;
			storage.onCloseBlockSidebar = null;
		};
	}, [editor]);

	// Handle image selection from media picker
	const handleImageSelect = React.useCallback(
		(item: MediaItem) => {
			if (editor) {
				// For external providers, src is only used for admin preview
				// The frontend Image component uses provider + mediaId to generate proper URLs
				editor
					.chain()
					.focus()
					.setImage({
						src: item.url,
						alt: item.alt || item.filename,
						mediaId: item.id,
						provider: item.provider || "local",
						width: item.width,
						height: item.height,
					})
					.run();
			}
			setMediaPickerOpen(false);
		},
		[editor],
	);

	// Handle plugin block insertion or update
	const handlePluginBlockInsert = React.useCallback(
		(values: Record<string, unknown>) => {
			if (!editor || !pluginBlockModal) return;

			const { id, ...data } = values;
			const editPos = editingBlockPosRef.current;

			if (editPos !== null) {
				// Editing an existing block — update its attributes in place
				const { tr } = editor.state;
				const node = tr.doc.nodeAt(editPos);
				if (node?.type.name === "pluginBlock") {
					tr.setNodeMarkup(editPos, undefined, {
						...node.attrs,
						id: typeof id === "string" ? id : node.attrs.id,
						data,
					});
					editor.view.dispatch(tr);
				}
			} else {
				// Inserting a new block
				editor
					.chain()
					.focus()
					.insertContent({
						type: "pluginBlock",
						attrs: {
							blockType: pluginBlockModal.type,
							id: typeof id === "string" ? id : "",
							data,
						},
					})
					.run();
			}

			setPluginBlockModal(null);
			setPluginBlockInitialValues(undefined);
			editingBlockPosRef.current = null;
		},
		[editor, pluginBlockModal],
	);

	// Handle slash menu command execution
	const handleSlashCommand = React.useCallback(
		(item: SlashCommandItem) => {
			if (editor && slashMenuState.range) {
				item.command({ editor, range: slashMenuState.range });
				setSlashMenuState((prev) => ({ ...prev, isOpen: false }));
			}
		},
		[editor, slashMenuState.range],
	);

	// Handle section selection - insert section content at cursor
	const handleSectionSelect = React.useCallback(
		(section: Section) => {
			if (!editor || !section.content || section.content.length === 0) return;

			// Convert Portable Text to ProseMirror format
			const ptContent = Array.isArray(section.content)
				? (section.content as PortableTextBlock[])
				: [];
			const { content: prosemirrorContent } = portableTextToProsemirror(ptContent);

			// Insert the content at current cursor position
			editor.chain().focus().insertContent(prosemirrorContent).run();
		},
		[editor],
	);

	if (!editor) {
		return (
			<div className={cn("border rounded-lg", className)}>
				<div className="p-4 text-kumo-subtle">Loading editor...</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"border rounded-lg overflow-hidden",
				minimal && "border-0 rounded-none -mx-4",
				focusMode === "spotlight" && "spotlight-mode",
				className,
			)}
			aria-labelledby={ariaLabelledby}
		>
			{!minimal && (
				<EditorToolbar
					editor={editor}
					focusMode={focusMode}
					onFocusModeChange={setFocusMode}
					editorStyles={editorStyles}
				/>
			)}
			<EditorBubbleMenu editor={editor} />
			<div className="relative overflow-visible">
				<EditorContent editor={editor} />
				{editable && <DragHandleWrapper editor={editor} />}
			</div>
			{!minimal && <EditorFooter editor={editor} />}

			{/* Slash command menu */}
			<SlashCommandMenu
				state={slashMenuState}
				onCommand={handleSlashCommand}
				onClose={() => setSlashMenuState((prev) => ({ ...prev, isOpen: false }))}
				setSelectedIndex={(index) =>
					setSlashMenuState((prev) => ({ ...prev, selectedIndex: index }))
				}
			/>

			{/* Media picker for image insertion */}
			<MediaPickerModal
				open={mediaPickerOpen}
				onOpenChange={setMediaPickerOpen}
				onSelect={handleImageSelect}
				mimeTypeFilter="image/"
				title="Select Image"
			/>

			{/* Plugin block insertion/editing modal */}
			<PluginBlockModal
				block={pluginBlockModal}
				initialValues={pluginBlockInitialValues}
				onClose={() => {
					setPluginBlockModal(null);
					setPluginBlockInitialValues(undefined);
					editingBlockPosRef.current = null;
				}}
				onInsert={handlePluginBlockInsert}
			/>

			{/* Section picker modal */}
			<SectionPickerModal
				open={sectionPickerOpen}
				onOpenChange={setSectionPickerOpen}
				onSelect={handleSectionSelect}
			/>
		</div>
	);
}

/**
 * Bubble Menu - appears when text is selected
 * Shows inline formatting options and link editing
 */
function EditorBubbleMenu({ editor }: { editor: Editor }) {
	const [showLinkInput, setShowLinkInput] = React.useState(false);
	const [linkUrl, setLinkUrl] = React.useState("");
	const inputRef = React.useRef<HTMLInputElement>(null);

	// When bubble menu opens with link input, populate the URL
	React.useEffect(() => {
		if (showLinkInput) {
			const existingUrl = editor.getAttributes("link").href || "";
			setLinkUrl(existingUrl);
			// Focus input after state update
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
			options={{
				placement: "top",
				offset: 8,
				flip: true,
				shift: true,
			}}
			className="z-[100] flex items-center gap-0.5 rounded-lg border bg-kumo-base p-1 shadow-lg"
		>
			{showLinkInput ? (
				<div className="flex items-center gap-1">
					<Input
						ref={inputRef}
						type="url"
						placeholder="https://..."
						value={linkUrl}
						onChange={(e) => setLinkUrl(e.target.value)}
						onKeyDown={handleKeyDown}
						className="h-8 w-48 text-sm"
					/>
					<Button
						type="button"
						variant="ghost"
						shape="square"
						className="h-8 w-8"
						onClick={handleSetLink}
						title="Apply link"
						aria-label="Apply link"
					>
						<ArrowSquareOut className="h-4 w-4" />
					</Button>
					{editor.isActive("link") && (
						<Button
							type="button"
							variant="ghost"
							shape="square"
							className="h-8 w-8 text-kumo-danger"
							onClick={handleRemoveLink}
							title="Remove link"
							aria-label="Remove link"
						>
							<LinkBreak className="h-4 w-4" />
						</Button>
					)}
				</div>
			) : (
				<>
					<BubbleButton
						onClick={() => editor.chain().focus().toggleBold().run()}
						active={editor.isActive("bold")}
						title="Bold"
					>
						<TextB className="h-4 w-4" />
					</BubbleButton>
					<BubbleButton
						onClick={() => editor.chain().focus().toggleItalic().run()}
						active={editor.isActive("italic")}
						title="Italic"
					>
						<TextItalic className="h-4 w-4" />
					</BubbleButton>
					<BubbleButton
						onClick={() => editor.chain().focus().toggleUnderline().run()}
						active={editor.isActive("underline")}
						title="Underline"
					>
						<TextUnderline className="h-4 w-4" />
					</BubbleButton>
					<BubbleButton
						onClick={() => editor.chain().focus().toggleStrike().run()}
						active={editor.isActive("strike")}
						title="Strikethrough"
					>
						<TextStrikethrough className="h-4 w-4" />
					</BubbleButton>
					<BubbleButton
						onClick={() => editor.chain().focus().toggleCode().run()}
						active={editor.isActive("code")}
						title="Code"
					>
						<Code className="h-4 w-4" />
					</BubbleButton>
					<div className="w-px h-6 bg-kumo-line mx-1" />
					<BubbleButton
						onClick={() => setShowLinkInput(true)}
						active={editor.isActive("link")}
						title={editor.isActive("link") ? "Edit link" : "Add link"}
					>
						<LinkIcon className="h-4 w-4" />
					</BubbleButton>
				</>
			)}
		</BubbleMenu>
	);
}

function BubbleButton({
	onClick,
	active,
	title,
	children,
}: {
	onClick: () => void;
	active?: boolean;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			shape="square"
			className={cn("h-8 w-8", active && "bg-kumo-tint text-kumo-default")}
			onClick={onClick}
			title={title}
			aria-label={title}
		>
			{children}
		</Button>
	);
}

/**
 * Editor Toolbar
 *
 * Implements WAI-ARIA toolbar pattern with proper keyboard navigation.
 * Arrow keys move focus between buttons, Home/End jump to first/last.
 */
function EditorToolbar({
	editor,
	focusMode,
	onFocusModeChange,
	editorStyles = [],
}: {
	editor: Editor;
	focusMode: FocusMode;
	onFocusModeChange: (mode: FocusMode) => void;
	editorStyles?: PortableTextEditorProps["editorStyles"];
}) {
	const [mediaPickerOpen, setMediaPickerOpen] = React.useState(false);
	const [showLinkPopover, setShowLinkPopover] = React.useState(false);
	const [linkUrl, setLinkUrl] = React.useState("");
	const toolbarRef = React.useRef<HTMLDivElement>(null);
	const linkInputRef = React.useRef<HTMLInputElement>(null);

	// Subscribe to editor state changes for reactive button states
	const editorState = useEditorState({
		editor,
		selector: (ctx) => ({
			isBold: ctx.editor.isActive("bold"),
			isItalic: ctx.editor.isActive("italic"),
			isUnderline: ctx.editor.isActive("underline"),
			isStrike: ctx.editor.isActive("strike"),
			isCode: ctx.editor.isActive("code"),
			isHeading1: ctx.editor.isActive("heading", { level: 1 }),
			isHeading2: ctx.editor.isActive("heading", { level: 2 }),
			isHeading3: ctx.editor.isActive("heading", { level: 3 }),
			isBulletList: ctx.editor.isActive("bulletList"),
			isOrderedList: ctx.editor.isActive("orderedList"),
			isBlockquote: ctx.editor.isActive("blockquote"),
			isCodeBlock: ctx.editor.isActive("codeBlock"),
			isAlignLeft: ctx.editor.isActive({ textAlign: "left" }),
			isAlignCenter: ctx.editor.isActive({ textAlign: "center" }),
			isAlignRight: ctx.editor.isActive({ textAlign: "right" }),
			isLink: ctx.editor.isActive("link"),
			canUndo: ctx.editor.can().undo(),
			canRedo: ctx.editor.can().redo(),
		}),
	});

	// Populate link URL when opening popover
	React.useEffect(() => {
		if (showLinkPopover) {
			const existingUrl = editor.getAttributes("link").href || "";
			setLinkUrl(existingUrl);
			setTimeout(() => linkInputRef.current?.focus(), 0);
		}
	}, [showLinkPopover, editor]);

	const handleSetLink = () => {
		if (linkUrl.trim() === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
		} else {
			editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl.trim() }).run();
		}
		setShowLinkPopover(false);
		setLinkUrl("");
	};

	const handleRemoveLink = () => {
		editor.chain().focus().extendMarkRange("link").unsetLink().run();
		setShowLinkPopover(false);
		setLinkUrl("");
	};

	const handleLinkKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSetLink();
		} else if (e.key === "Escape") {
			setShowLinkPopover(false);
			setLinkUrl("");
			editor.commands.focus();
		}
	};

	const handleImageSelect = React.useCallback(
		(item: MediaItem) => {
			editor
				.chain()
				.focus()
				.setImage({
					src: item.url,
					alt: item.alt || item.filename,
					mediaId: item.id,
					width: item.width,
					height: item.height,
				})
				.run();
		},
		[editor],
	);

	// Keyboard navigation for toolbar (WAI-ARIA toolbar pattern)
	const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		const toolbar = toolbarRef.current;
		if (!toolbar) return;

		const buttons = [
			...toolbar.querySelectorAll<HTMLButtonElement>(
				'button:not([disabled]), [role="button"]:not([disabled])',
			),
		];
		const currentIndex = buttons.findIndex((btn) => btn === document.activeElement);
		if (currentIndex === -1) return;

		let nextIndex: number | null = null;

		switch (e.key) {
			case "ArrowRight":
			case "ArrowDown":
				nextIndex = (currentIndex + 1) % buttons.length;
				break;
			case "ArrowLeft":
			case "ArrowUp":
				nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
				break;
			case "Home":
				nextIndex = 0;
				break;
			case "End":
				nextIndex = buttons.length - 1;
				break;
			default:
				return;
		}

		if (nextIndex !== null) {
			e.preventDefault();
			buttons[nextIndex]?.focus();
		}
	}, []);

	return (
		<div
			ref={toolbarRef}
			role="toolbar"
			aria-label="Text formatting"
			className="border-b bg-kumo-tint/50 p-1 flex flex-wrap gap-0.5"
			onKeyDown={handleKeyDown}
		>
			{/* Text formatting */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleBold().run()}
					active={editorState.isBold}
					title="Bold"
				>
					<TextB className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleItalic().run()}
					active={editorState.isItalic}
					title="Italic"
				>
					<TextItalic className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleUnderline().run()}
					active={editorState.isUnderline}
					title="Underline"
				>
					<TextUnderline className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleStrike().run()}
					active={editorState.isStrike}
					title="Strikethrough"
				>
					<TextStrikethrough className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleCode().run()}
					active={editorState.isCode}
					title="Inline Code"
				>
					<Code className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* Headings */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
					active={editorState.isHeading1}
					title="Heading 1"
				>
					<TextHOne className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
					active={editorState.isHeading2}
					title="Heading 2"
				>
					<TextHTwo className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
					active={editorState.isHeading3}
					title="Heading 3"
				>
					<TextHThree className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* Lists and blocks */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleBulletList().run()}
					active={editorState.isBulletList}
					title="Bullet List"
				>
					<List className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleOrderedList().run()}
					active={editorState.isOrderedList}
					title="Numbered List"
				>
					<ListNumbers className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleBlockquote().run()}
					active={editorState.isBlockquote}
					title="Quote"
				>
					<Quotes className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleCodeBlock().run()}
					active={editorState.isCodeBlock}
					title="Code Block"
				>
					<CodeBlock className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* Text alignment */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => editor.chain().focus().setTextAlign("left").run()}
					active={editorState.isAlignLeft}
					title="Align Left"
				>
					<TextAlignLeft className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().setTextAlign("center").run()}
					active={editorState.isAlignCenter}
					title="Align Center"
				>
					<TextAlignCenter className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().setTextAlign("right").run()}
					active={editorState.isAlignRight}
					title="Align Right"
				>
					<TextAlignRight className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			{/* Plugin editor styles */}
			{editorStyles.length > 0 && (
				<>
					<ToolbarSeparator />
					<ToolbarGroup>
						<EditorStyleToolbar editor={editor} styles={editorStyles} />
					</ToolbarGroup>
				</>
			)}

			<ToolbarSeparator />

			{/* Insert */}
			<ToolbarGroup>
				{/* Link with popover */}
				<div className="relative">
					<ToolbarButton
						onClick={() => setShowLinkPopover(!showLinkPopover)}
						active={editorState.isLink}
						title="Insert Link"
					>
						<LinkIcon className="h-4 w-4" aria-hidden="true" />
					</ToolbarButton>
					{showLinkPopover && (
						<div className="absolute top-full left-0 mt-1 z-50 rounded-md border bg-kumo-overlay p-3 shadow-lg">
							<div className="flex flex-col gap-2">
								<label className="text-xs font-medium text-kumo-subtle">URL</label>
								<div className="flex items-center gap-1">
									<Input
										ref={linkInputRef}
										type="url"
										placeholder="https://..."
										value={linkUrl}
										onChange={(e) => setLinkUrl(e.target.value)}
										onKeyDown={handleLinkKeyDown}
										className="h-8 w-52 text-sm"
									/>
								</div>
								<div className="flex justify-between">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => {
											setShowLinkPopover(false);
											setLinkUrl("");
										}}
									>
										Cancel
									</Button>
									<div className="flex gap-1">
										{editorState.isLink && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="text-kumo-danger"
												onClick={handleRemoveLink}
												icon={<LinkBreak />}
											>
												Remove
											</Button>
										)}
										<Button type="button" variant="primary" size="sm" onClick={handleSetLink}>
											Apply
										</Button>
									</div>
								</div>
							</div>
						</div>
					)}
				</div>
				<ToolbarButton onClick={() => setMediaPickerOpen(true)} title="Insert Image">
					<ImageIcon className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().setHorizontalRule().run()}
					title="Insert Horizontal Rule"
				>
					<Minus className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator aria-hidden="true" />

			{/* History */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => editor.chain().focus().undo().run()}
					disabled={!editorState.canUndo}
					title="Undo"
				>
					<ArrowUUpLeft className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().redo().run()}
					disabled={!editorState.canRedo}
					title="Redo"
				>
					<ArrowUUpRight className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator aria-hidden="true" />

			{/* Focus mode & code mode */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => onFocusModeChange(focusMode === "spotlight" ? "normal" : "spotlight")}
					active={focusMode === "spotlight"}
					title={focusMode === "spotlight" ? "Exit Spotlight Mode" : "Spotlight Mode"}
				>
					<Eye className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			{/* Media Picker Modal */}
			<MediaPickerModal
				open={mediaPickerOpen}
				onOpenChange={setMediaPickerOpen}
				onSelect={handleImageSelect}
				mimeTypeFilter="image/"
				title="Select Image"
			/>
		</div>
	);
}

function ToolbarGroup({ children }: { children: React.ReactNode }) {
	return <div className="flex gap-0.5">{children}</div>;
}

function ToolbarSeparator() {
	return <div className="w-px bg-kumo-line mx-1" />;
}

interface ToolbarButtonProps {
	onClick?: () => void;
	active?: boolean;
	disabled?: boolean;
	title: string; // Required for accessibility
	children: React.ReactNode;
}

function ToolbarButton({ onClick, active, disabled, title, children }: ToolbarButtonProps) {
	return (
		<Button
			type="button"
			variant="ghost"
			shape="square"
			className={cn("h-8 w-8", active && "bg-kumo-tint text-kumo-default")}
			onMouseDown={(e) => e.preventDefault()}
			onClick={onClick}
			disabled={disabled}
			aria-label={title}
			aria-pressed={active}
			tabIndex={0}
		>
			{children}
		</Button>
	);
}

export default PortableTextEditor;
