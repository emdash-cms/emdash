/**
 * Self-contained inline Portable Text editor for visual editing.
 *
 * Uses TipTap directly with content extensions — no admin UI deps.
 * Includes the admin editor's selection toolbar and slash menu, and a
 * toolbar and picker for images, but no fixed toolbar, sidebar, or section
 * picker.
 *
 * Converts between Portable Text and ProseMirror on mount/save.
 * Auto-saves on blur, dispatches custom events for toolbar integration.
 */

import { htmlBlockFields } from "@emdash-cms/admin/html-block";
import { Node, mergeAttributes, type JSONContent } from "@tiptap/core";
import Focus from "@tiptap/extension-focus";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { exitSuggestion } from "@tiptap/suggestion";
import * as React from "react";

import { resolveImageMedia } from "../content/converters/gallery.js";
import { normalizeImageLink } from "../content/converters/image-link.js";
import {
	assertPortableTextMarksSupported,
	assertProseMirrorMarksSupported,
	UnsupportedPortableTextMarksError,
} from "../content/converters/mark-safety.js";
import {
	deriveLegacyListId,
	normalizeProseMirrorOrderedListJson,
	normalizeListId,
	normalizeListStart,
	readOrderedListMetadata,
} from "../content/converters/numbered-list.js";
import type { ProseMirrorDocument } from "../content/converters/types.js";
import { CodeMarkExtension } from "./code-mark.js";
import { InlineBubbleMenu } from "./inline-bubble-menu.js";
import { InlineCodeBlockExtension } from "./inline-code-block.js";
import { INLINE_EDITOR_UI_STYLES, useInlineUiRoot } from "./inline-editor-ui.js";
import { INLINE_IMAGE_STYLES, InlineImageExtension, insertImage } from "./inline-image.js";
import { INLINE_MEDIA_PICKER_STYLES, InlineMediaPicker } from "./inline-media-picker.js";
import {
	InlineSlashMenu,
	createSlashCommandsExtension,
	initialSlashMenuState,
	type SlashCommandItem,
	type SlashMenuState,
} from "./inline-slash-menu.js";
import { EmDashOrderedList } from "./ordered-list.js";

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
	listId?: string;
	listStart?: number;
	children: PTSpan[];
	markDefs?: PTMarkDef[];
	textAlign?: "left" | "center" | "right" | "justify";
}

type PTTableBlock = { _type: "table"; [key: string]: unknown };
type PTBlock = PTTextBlock | PTTableBlock | { _type: string; _key: string; [key: string]: unknown };
const TABLE_BLOCK_PLACEHOLDER_HTML = /<[^>]+\bdata-emdash-table-block(?:\s|=|>)/i;

/** Type guard for PTTextBlock */
function isPTTextBlock(block: PTBlock): block is PTTextBlock {
	return block._type === "block";
}

function isPTTableBlock(value: unknown): value is PTTableBlock {
	return typeof value === "object" && value !== null && "_type" in value && value._type === "table";
}

/** Type guard for a ProseMirror JSON document. */
function isProseMirrorDocument(value: unknown): value is ProseMirrorDocument {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "doc" &&
		"content" in value &&
		Array.isArray(value.content)
	);
}

// ── Helpers ────────────────────────────────────────────────────────

function k(): string {
	return Math.random().toString(36).substring(2, 11);
}

function getUnsupportedFileGuidance(locale: string): string {
	if (locale.toLowerCase().startsWith("ar")) {
		return "لا يمكن إفلات الملفات أو لصقها هنا. اكتب /image لاختيار صورة من مكتبة الوسائط.";
	}
	return "Files can’t be dropped or pasted here. Type /image to choose an image from the media library.";
}

function hasTransferredFiles(transfer: DataTransfer | null): boolean {
	if (!transfer) return false;
	if (transfer.files.length > 0) return true;
	for (let index = 0; index < transfer.items.length; index++) {
		if (transfer.items[index]?.kind === "file") return true;
	}
	return false;
}

function createUnsupportedFileHandlers(showGuidance: () => void) {
	const keepFileDragInEditor = (_view: unknown, event: DragEvent): boolean => {
		if (!hasTransferredFiles(event.dataTransfer)) return false;
		event.preventDefault();
		return true;
	};
	return {
		handleDOMEvents: {
			dragenter: keepFileDragInEditor,
			dragover: keepFileDragInEditor,
			drop: (_view: unknown, event: DragEvent): boolean => {
				if (!hasTransferredFiles(event.dataTransfer)) return false;
				event.preventDefault();
				showGuidance();
				return true;
			},
			paste: (_view: unknown, event: ClipboardEvent): boolean => {
				if (!hasTransferredFiles(event.clipboardData)) return false;
				event.preventDefault();
				showGuidance();
				return true;
			},
		},
	};
}

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
	return typeof v === "string" && v ? v : undefined;
}

/** Safely extract a number attribute from ProseMirror attrs */
function attrNum(attrs: Record<string, unknown> | undefined, key: string): number | undefined {
	const v = attrs?.[key];
	return typeof v === "number" ? v : undefined;
}

function attrDimension(
	attrs: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = attrNum(attrs, key);
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

type ImageAlignment = "left" | "center" | "right" | "wide" | "full";

function imageAlignment(value: unknown): ImageAlignment | undefined {
	return value === "left" ||
		value === "center" ||
		value === "right" ||
		value === "wide" ||
		value === "full"
		? value
		: undefined;
}

function canonicalMediaProviderId(provider: string | undefined): string | undefined {
	return provider === "external-url" ? "external" : provider;
}

function pmToPortableText(doc: PMNode): PTBlock[] {
	if (!doc || doc.type !== "doc" || !doc.content) return [];
	const blocks: PTBlock[] = [];
	for (let i = 0; i < doc.content.length; i++) {
		const r = convertPMNode(doc.content[i]!, `root:${i}`);
		if (r) {
			if (Array.isArray(r)) blocks.push(...r);
			else blocks.push(r);
		}
	}
	return blocks;
}

function convertPMNode(node: PMNode, path: string): PTBlock | PTBlock[] | null {
	switch (node.type) {
		case "paragraph": {
			const { children, markDefs } = convertInline(node.content || []);
			if (children.length === 0) return null;
			const ta = node.attrs?.textAlign;
			const textAlign = ta === "center" || ta === "right" || ta === "justify" ? ta : undefined;
			return {
				_type: "block",
				_key: k(),
				style: "normal",
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
				...(textAlign ? { textAlign } : {}),
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
			const ta = node.attrs?.textAlign;
			const textAlign = ta === "center" || ta === "right" || ta === "justify" ? ta : undefined;
			return {
				_type: "block",
				_key: k(),
				style: headingStyle,
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
				...(textAlign ? { textAlign } : {}),
			};
		}
		case "bulletList":
			return convertPMList(node.content || [], "bullet", 1, node.attrs, path);
		case "orderedList":
			return convertPMList(node.content || [], "number", 1, node.attrs, path);
		case "blockquote": {
			const blocks: PTTextBlock[] = [];
			for (const child of node.content || []) {
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInline(child.content || []);
					if (children.length > 0) {
						blocks.push({
							_type: "block",
							_key: k(),
							style: "blockquote",
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
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
		case "htmlBlock":
			return {
				_type: "htmlBlock",
				_key: k(),
				...htmlBlockFields(node.attrs ?? {}),
			};
		case "image": {
			const provider = attrStrOpt(node.attrs, "provider");
			const blurhash = attrStrOpt(node.attrs, "blurhash");
			const dominantColor = attrStrOpt(node.attrs, "dominantColor");
			const title = attrStrOpt(node.attrs, "title");
			const caption = Object.hasOwn(node.attrs ?? {}, "caption")
				? (attrStrOpt(node.attrs, "caption") ?? (title ? "" : undefined))
				: title;
			// Persist LQIP as first-class block fields (matching the image-field
			// MediaValue path) rather than nesting in `asset.meta`, so read sites
			// and normalize don't need a dual-shape fallback. `asset.meta` is left
			// to carry only provider-specific data — it isn't reconstructed here,
			// so non-LQIP meta keys are never silently dropped on editor round-trip.
			return {
				_type: "image",
				_key: k(),
				asset: {
					_ref: attrStr(node.attrs, "mediaId"),
					url: attrStr(node.attrs, "src"),
					provider: provider && provider !== "local" ? provider : undefined,
				},
				alt: attrStrOpt(node.attrs, "alt"),
				caption,
				title,
				width: attrDimension(node.attrs, "width"),
				height: attrDimension(node.attrs, "height"),
				...(blurhash ? { blurhash } : {}),
				...(dominantColor ? { dominantColor } : {}),
				displayWidth: attrDimension(node.attrs, "displayWidth"),
				displayHeight: attrDimension(node.attrs, "displayHeight"),
				alignment: imageAlignment(node.attrs?.alignment),
				link: normalizeImageLink(node.attrs?.link) ?? undefined,
			};
		}
		case "horizontalRule":
			return { _type: "break", _key: k(), style: "lineBreak" };
		case "table": {
			const rawTable = node.attrs?.rawTable;
			if (isPTTableBlock(rawTable)) return rawTable;
			return null;
		}
		case "pluginBlock": {
			// Spread the captured data back out so the block round-trips losslessly.
			// `data` holds every field except _type / _key and the identity field
			// (`id` or `url`, named by `identityField`), which live on dedicated attrs.
			const { blockType, id, identityField, data } = node.attrs ?? {};
			const field = identityField === "url" || identityField === "" ? identityField : "id";
			return {
				...(data && typeof data === "object" ? data : {}),
				_type: typeof blockType === "string" ? blockType : "embed",
				_key: k(),
				...(field ? { [field]: typeof id === "string" ? id : "" } : {}),
			};
		}
		default:
			return null;
	}
}

function convertPMList(
	items: PMNode[],
	listItem: "bullet" | "number",
	level: number,
	attrs: Record<string, unknown> | undefined,
	path: string,
): PTTextBlock[] {
	const blocks: PTTextBlock[] = [];
	const metadata = listItem === "number" ? readOrderedListMetadata(attrs, path) : undefined;
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex]!;
		if (item.type === "listItem") {
			for (let childIndex = 0; childIndex < (item.content?.length ?? 0); childIndex++) {
				const child = item.content![childIndex]!;
				if (child.type === "paragraph") {
					const { children, markDefs } = convertInline(child.content || []);
					if (children.length > 0) {
						blocks.push({
							_type: "block",
							_key: k(),
							style: "normal",
							listItem,
							level,
							...metadata,
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
					}
				} else if (child.type === "bulletList" || child.type === "orderedList") {
					const childListItem = child.type === "bulletList" ? "bullet" : "number";
					blocks.push(
						...convertPMList(
							child.content || [],
							childListItem,
							level + 1,
							child.attrs,
							`${path}:${itemIndex}:${childIndex}`,
						),
					);
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
		default:
			return mark.type;
	}
}

// ── Portable Text → ProseMirror ────────────────────────────────────

function portableTextToPM(blocks: PTBlock[]): JSONContent {
	if (!blocks || blocks.length === 0) return { type: "doc", content: [{ type: "paragraph" }] };
	assertPortableTextMarksSupported(blocks);

	const content: PMNode[] = [];
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
			const runStart = i;
			const rootId = listType === "number" ? normalizeListId(block.listId) : undefined;
			while (i < blocks.length) {
				const cur = blocks[i];
				if (!cur || !isPTTextBlock(cur) || !cur.listItem) break;
				const level = cur.level || 1;
				const currentId = cur.listItem === "number" ? normalizeListId(cur.listId) : undefined;
				const sameIdentity =
					listType !== "number" ||
					level > 1 ||
					(rootId ? currentId === rootId : currentId === undefined);
				if (level > 1 || (cur.listItem === listType && sameIdentity)) {
					listBlocks.push(cur);
					i++;
				} else break;
			}
			content.push(convertPTList(listBlocks, listType, `root:${runStart}`));
		} else if (
			isPTTextBlock(block) &&
			block.style === "blockquote" &&
			block.listItem === undefined
		) {
			// Group consecutive blockquote blocks into ONE blockquote node —
			// PT is flat, so a multi-paragraph quote is stored as a run of
			// blockquote-styled blocks. Mirrors the grouping in
			// content/converters/portable-text-to-prosemirror.ts; without it
			// merges revert on reload in the inline editor too.
			const quoteBlocks: PTTextBlock[] = [];
			while (i < blocks.length) {
				const cur = blocks[i];
				if (
					!cur ||
					!isPTTextBlock(cur) ||
					cur.style !== "blockquote" ||
					cur.listItem !== undefined
				) {
					break;
				}
				quoteBlocks.push(cur);
				i++;
			}
			content.push({
				type: "blockquote",
				content: quoteBlocks.map((quoteBlock) => {
					const pmContent = convertPTSpans(quoteBlock.children, quoteBlock.markDefs || []);
					return {
						type: "paragraph",
						content: pmContent.length > 0 ? pmContent : undefined,
					};
				}),
			});
		} else {
			const c = convertPTBlock(block);
			if (c) content.push(c);
			i++;
		}
	}

	return normalizeProseMirrorOrderedListJson({
		type: "doc",
		content: content.length > 0 ? content : [{ type: "paragraph" }],
	});
}

function convertPTBlock(block: PTBlock): PMNode | null {
	if (isPTTextBlock(block)) {
		const { style = "normal", children, markDefs = [], textAlign } = block;
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
				attrs: { level, ...(textAlign ? { textAlign } : {}) },
				content: pmContent.length > 0 ? pmContent : undefined,
			};
		}
		return {
			type: "paragraph",
			attrs: textAlign ? { textAlign } : undefined,
			content: pmContent.length > 0 ? pmContent : undefined,
		};
	}
	if (block._type === "code") {
		const cb = block as PTBlock & { code?: string; language?: string };
		const language = typeof cb.language === "string" && cb.language.length > 0 ? cb.language : null;
		return {
			type: "codeBlock",
			attrs: { language },
			content: cb.code ? [{ type: "text", text: cb.code }] : undefined,
		};
	}
	if (block._type === "break") {
		return { type: "horizontalRule" };
	}
	if (block._type === "htmlBlock") {
		return {
			type: "htmlBlock",
			attrs: { ...htmlBlockFields(block) },
		};
	}
	if (block._type === "image") {
		const ib = block as PTBlock & {
			asset?: {
				_ref?: string;
				url?: string;
				provider?: string;
				meta?: Record<string, unknown>;
			};
			url?: string;
			alt?: string;
			caption?: string;
			title?: string;
			width?: number;
			height?: number;
			/** LQIP — first-class field (legacy snapshots keep it in `asset.meta`). */
			blurhash?: string;
			dominantColor?: string;
			displayWidth?: number;
			displayHeight?: number;
			alignment?: unknown;
			/** `{ href, blank? }`, or a bare string on WordPress-imported content */
			link?: unknown;
		};
		const meta = ib.asset?.meta;
		const { asset, alt, width, height } = resolveImageMedia(ib);
		// Prefer first-class LQIP fields; fall back to `asset.meta` for legacy.
		const blurhash =
			typeof ib.blurhash === "string"
				? ib.blurhash
				: typeof meta?.blurhash === "string"
					? meta.blurhash
					: null;
		const dominantColor =
			typeof ib.dominantColor === "string"
				? ib.dominantColor
				: typeof meta?.dominantColor === "string"
					? meta.dominantColor
					: null;
		return {
			type: "image",
			attrs: {
				src: asset.url || ib.url || (asset._ref ? `/_emdash/api/media/file/${asset._ref}` : ""),
				alt: alt || "",
				title: ib.title || "",
				caption: Object.hasOwn(ib, "caption") ? ib.caption || "" : ib.title || "",
				mediaId: asset._ref || undefined,
				provider: canonicalMediaProviderId(asset.provider),
				width,
				height,
				blurhash,
				dominantColor,
				displayWidth: ib.displayWidth,
				displayHeight: ib.displayHeight,
				alignment: imageAlignment(ib.alignment) ?? null,
				link: normalizeImageLink(ib.link),
			},
		};
	}
	if (block._type === "table") {
		return {
			type: "table",
			attrs: { rawTable: block },
		};
	}
	// Unknown block types — treat as plugin blocks. Capture every field other
	// than the well-known ones into `data` so the block round-trips losslessly,
	// even if no plugin currently registers this type. Matches the admin
	// editor's `convertCustomBlock`.
	// The identity lives under whichever of `id` / `url` the block arrived with,
	// so the PM → PT direction can write it back under the same key.
	const identityField =
		typeof block.id === "string" ? "id" : typeof block.url === "string" ? "url" : "";
	const identity = identityField ? block[identityField] : undefined;
	// Filter out _-prefixed keys to prevent accumulation across edit cycles.
	const data = Object.fromEntries(
		Object.entries(block).filter(([key]) => !key.startsWith("_") && key !== identityField),
	);
	return {
		type: "pluginBlock",
		attrs: {
			blockType: typeof block._type === "string" ? block._type : "embed",
			id: typeof identity === "string" ? identity : "",
			identityField,
			data,
		},
	};
}

function convertPTList(
	items: PTTextBlock[],
	listType: "bullet" | "number",
	context: string,
): PMNode {
	const rootItems: PMNode[] = [];
	let index = 0;

	while (index < items.length) {
		const item = items[index]!;
		const level = item.level || 1;
		if (level === 1) {
			const nestedItems: PTTextBlock[] = [];
			index++;
			while (index < items.length && (items[index]!.level || 1) > 1) {
				nestedItems.push(items[index]!);
				index++;
			}
			rootItems.push(
				convertPTListItem(item, nestedItems, listType, `${context}:${rootItems.length}`),
			);
		} else {
			rootItems.push(convertPTListItem(item, [], listType, `${context}:${rootItems.length}`));
			index++;
		}
	}

	const firstItem = items[0]!;
	const listId =
		normalizeListId(firstItem.listId) ?? deriveLegacyListId(`${context}:${firstItem._key}`);
	const listStart = normalizeListStart(firstItem.listStart);
	const metadata =
		listType === "number"
			? {
					listId,
					...(listStart === undefined ? {} : { listStart }),
				}
			: undefined;
	return {
		type: listType === "bullet" ? "bulletList" : "orderedList",
		attrs: metadata ? { ...metadata, start: metadata.listStart ?? 1 } : undefined,
		content: rootItems,
	};
}

function belongsToNestedPTGroup(
	item: PTTextBlock,
	minLevel: number,
	parentListType: "bullet" | "number",
	anchorType: "bullet" | "number",
	anchorId: string | undefined,
): boolean {
	if ((item.level || 2) > minLevel) return true;
	if ((item.listItem || parentListType) !== anchorType) return false;
	if (anchorType !== "number") return true;
	const itemId = normalizeListId(item.listId);
	return anchorId ? itemId === anchorId : itemId === undefined;
}

function convertPTListItem(
	item: PTTextBlock,
	nestedItems: PTTextBlock[],
	parentListType: "bullet" | "number",
	context: string,
): PMNode {
	const content: PMNode[] = [
		{
			type: "paragraph",
			content: convertPTSpans(item.children, item.markDefs || []),
		},
	];

	if (nestedItems.length > 0) {
		let minLevel = Infinity;
		for (const nestedItem of nestedItems) {
			const level = nestedItem.level || 2;
			if (level < minLevel) minLevel = level;
		}

		let index = 0;
		while (index < nestedItems.length) {
			const groupStart = index;
			const anchorType = nestedItems[index]!.listItem || parentListType;
			const anchorId =
				anchorType === "number" ? normalizeListId(nestedItems[index]!.listId) : undefined;
			const nestedGroup: PTTextBlock[] = [];
			do {
				nestedGroup.push(nestedItems[index]!);
				index++;
			} while (
				index < nestedItems.length &&
				belongsToNestedPTGroup(nestedItems[index]!, minLevel, parentListType, anchorType, anchorId)
			);

			content.push(
				convertPTList(
					nestedGroup.map((nestedItem) => ({
						...nestedItem,
						level: (nestedItem.level || 2) - 1,
					})),
					anchorType,
					`${context}:nested:${groupStart}`,
				),
			);
		}
	}

	return { type: "listItem", content };
}

function convertPTSpans(spans: PTSpan[], markDefs: PTMarkDef[]): PMNode[] {
	const nodes: PMNode[] = [];
	const mdMap = new Map(markDefs.map((md) => [md._key, md]));

	for (const span of spans) {
		if (span._type !== "span") continue;
		const parts = span.text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			const text = parts[i];
			if (text && text.length > 0) {
				const marks = convertPTMarks(span.marks || [], mdMap);
				const node: PMNode = {
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
			case "superscript":
				pm.push({ type: "superscript" });
				break;
			case "subscript":
				pm.push({ type: "subscript" });
				break;
			default: {
				const md = markDefs.get(mark);
				if (md && md._type === "link") {
					pm.push({
						type: "link",
						attrs: { href: md.href, target: md.blank ? "_blank" : null },
					});
				}
				break;
			}
		}
	}
	return pm;
}

/**
 * Minimal `htmlBlock` TipTap node for the inline (visual-editing) editor.
 *
 * Like PluginBlockNode below, this renders as a read-only placeholder so the
 * block's data is preserved across edits in the visual editor. Full editing
 * (textarea + preview) is only available in the admin editor.
 */
const HtmlBlockNode = Node.create({
	name: "htmlBlock",
	group: "block",
	atom: true,
	selectable: true,
	draggable: true,

	addAttributes() {
		const noDom = { rendered: false, parseHTML: () => null };
		return {
			html: { default: "", ...noDom },
			css: { default: "", ...noDom },
			js: { default: "", ...noDom },
			isolated: { default: false, ...noDom },
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-emdash-html-block="true"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-emdash-html-block": "true",
				class: "emdash-plugin-block-placeholder",
				contenteditable: "false",
			}),
			"HTML block (edit in admin)",
		];
	},
});

const TableBlockNode = Node.create<{ placeholder: string }>({
	name: "table",
	group: "block",
	atom: true,
	selectable: true,
	draggable: true,

	addOptions() {
		return { placeholder: "Table (edit in admin)" };
	},

	addAttributes() {
		return {
			rawTable: { default: null, rendered: false, parseHTML: () => null },
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-emdash-table-block="true"]' }];
	},

	addProseMirrorPlugins() {
		return [
			new Plugin({
				props: {
					handleDOMEvents: {
						cut: (view, event) => {
							let hasTable = false;
							view.state.selection.content().content.descendants((node) => {
								hasTable ||= node.type.name === "table";
							});
							if (!hasTable) return false;
							event.preventDefault();
							return true;
						},
					},
					handlePaste: (_view, event, slice) => {
						const html = event.clipboardData?.getData("text/html") ?? "";
						if (!TABLE_BLOCK_PLACEHOLDER_HTML.test(html)) return false;

						let hasTable = false;
						let hasMissingPayload = false;
						slice.content.descendants((node) => {
							if (node.type.name !== "table") return;
							hasTable = true;
							if (!isPTTableBlock(node.attrs.rawTable)) hasMissingPayload = true;
						});
						if (hasTable && !hasMissingPayload) return false;

						event.preventDefault();
						return true;
					},
				},
			}),
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-emdash-table-block": "true",
				class: "emdash-plugin-block-placeholder",
				contenteditable: "false",
			}),
			this.options.placeholder,
		];
	},
});

/**
 * Minimal `pluginBlock` TipTap node for the inline (visual-editing) editor.
 *
 * Plugin-contributed Portable Text block types (e.g. `marketing.hero`) are
 * editable in the admin via a Block Kit modal. The visual-editing surface
 * deliberately does NOT offer that UX — it would need to fetch the manifest,
 * mount the modal, and round-trip through plugin-block plumbing that lives in
 * `@emdash-cms/admin`. Instead, the inline editor renders these blocks as a
 * read-only placeholder so editors can see they exist and edit the surrounding
 * content without losing the block's data.
 *
 * The full block payload is preserved on `data` and round-tripped losslessly
 * through PT ↔ PM conversion (see convertPTBlock/convertPMNode). Without this
 * extension, ProseMirror's schema would silently filter unknown nodes on load
 * and the next save would persist the block's disappearance.
 */
const PluginBlockNode = Node.create({
	name: "pluginBlock",
	group: "block",
	atom: true,
	selectable: true,
	draggable: true,

	addAttributes() {
		// These attributes are stored on the ProseMirror node but not
		// rendered as DOM attributes — they're metadata for the round-trip,
		// not styling or behaviour the placeholder DOM needs to expose.
		const noDom = { rendered: false, parseHTML: () => null };
		return {
			blockType: { default: "", ...noDom },
			id: { default: "", ...noDom },
			identityField: { default: "id", ...noDom },
			data: { default: {}, ...noDom },
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-emdash-plugin-block="true"]' }];
	},

	renderHTML({ HTMLAttributes, node }) {
		const blockType = typeof node.attrs.blockType === "string" ? node.attrs.blockType : "";
		const label = blockType || "Block";
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-emdash-plugin-block": "true",
				"data-block-type": blockType,
				class: "emdash-plugin-block-placeholder",
				contenteditable: "false",
			}),
			`Plugin block: ${label} (edit in admin)`,
		];
	},
});

// ── Component ──────────────────────────────────────────────────────

export interface InlinePortableTextEditorProps {
	value: PTBlock[];
	collection: string;
	entryId: string;
	field: string;
	tablePlaceholder?: string;
}

export function InlinePortableTextEditor({
	value,
	collection,
	entryId,
	field,
	tablePlaceholder = TableBlockNode.options.placeholder,
}: InlinePortableTextEditorProps) {
	const initialRef = React.useRef(value);
	// The editor document last known to be stored: the one the loaded content
	// produced, then the one each successful save sent. `save()` does nothing
	// while the current document is structurally equal to it (`Node.eq`).
	const savedDocRef = React.useRef<Editor["state"]["doc"] | null>(null);
	const savingRef = React.useRef(false);
	const editorRef = React.useRef<ReturnType<typeof useEditor>>(null);

	// Where the image picker that `/image` opened will put the image.
	const [imagePickerAt, setImagePickerAt] = React.useState<number | null>(null);
	const [unsupportedFileGuidance, setUnsupportedFileGuidance] = React.useState<{
		message: string;
		version: number;
	} | null>(null);
	const showUnsupportedFileGuidance = React.useCallback(() => {
		const locale = document.documentElement.lang || navigator.language;
		setUnsupportedFileGuidance((current) => ({
			message: getUnsupportedFileGuidance(locale),
			version: (current?.version ?? 0) + 1,
		}));
	}, []);
	const unsupportedFileHandlers = React.useMemo(
		() => createUnsupportedFileHandlers(showUnsupportedFileGuidance),
		[showUnsupportedFileGuidance],
	);

	const uiRoot = useInlineUiRoot();

	// The Suggestion plugin's key handlers read the slash menu's state as soon
	// as it changes, before React commits it, so the ref takes each change
	// synchronously and the extension, created once, reads the ref.
	const [slashMenuState, setSlashMenuStateRaw] =
		React.useState<SlashMenuState>(initialSlashMenuState);
	const slashMenuStateRef = React.useRef(slashMenuState);
	const setSlashMenuState: React.Dispatch<React.SetStateAction<SlashMenuState>> = React.useCallback(
		(action) => {
			const next = typeof action === "function" ? action(slashMenuStateRef.current) : action;
			slashMenuStateRef.current = next;
			setSlashMenuStateRaw(next);
		},
		[],
	);
	const slashMenuActionsRef = React.useRef({
		run: (_item: SlashCommandItem) => {},
		dismiss: () => {},
	});

	const [loadState] = React.useState<{
		content: JSONContent;
		error: UnsupportedPortableTextMarksError | null;
	}>(() => {
		try {
			return { content: portableTextToPM(value || []), error: null };
		} catch (error) {
			if (error instanceof UnsupportedPortableTextMarksError) {
				return {
					content: { type: "doc", content: [{ type: "paragraph" }] },
					error,
				};
			}
			throw error;
		}
	});

	const initialContent = loadState.content;
	const loadError = loadState.error;
	const [saveError, setSaveError] = React.useState<string | null>(null);

	const getBlocks = React.useCallback((): PTBlock[] => {
		const editor = editorRef.current;
		if (!editor) return initialRef.current;
		const json: unknown = editor.getJSON();
		if (!isProseMirrorDocument(json)) return initialRef.current;
		assertProseMirrorMarksSupported(json);
		return pmToPortableText(json);
	}, []);

	const save = React.useCallback(
		async (options?: { keepalive?: boolean }) => {
			// A pagehide flush must not be skipped: an in-flight blur save is
			// cancelled by the navigation, so the keepalive request is the only
			// one that can still land.
			if (loadError) return;
			if (savingRef.current && !options?.keepalive) return;

			const doc = editorRef.current?.state.doc;
			if (!doc || !savedDocRef.current || doc.eq(savedDocRef.current)) return;

			savingRef.current = true;
			let settle = () => {};
			const done = new Promise<void>((resolve) => {
				settle = () => resolve();
			});
			// The visual-editing toolbar holds Publish until `done` settles.
			document.dispatchEvent(new CustomEvent("emdash:save-pending", { detail: { done } }));
			try {
				const blocks = getBlocks();
				const res = await fetch(
					`/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}`,
					{
						method: "PUT",
						credentials: "same-origin",
						headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
						body: JSON.stringify({ data: { [field]: blocks }, skipRevision: true }),
						keepalive: options?.keepalive ?? false,
					},
				);

				if (res.ok) {
					setSaveError(null);
					initialRef.current = blocks;
					savedDocRef.current = doc;
					document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "saved" } }));
					document.dispatchEvent(
						new CustomEvent("emdash:content-changed", {
							detail: { collection, id: entryId },
						}),
					);
				} else {
					setSaveError(`Save failed: ${res.status}`);
					document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
					console.error("Save failed:", res.status);
				}
			} catch (err) {
				setSaveError(
					err instanceof UnsupportedPortableTextMarksError
						? `Save failed: unsupported formatting (${err.marks.join(", ")}).`
						: "Save failed. Please try again.",
				);
				document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "error" } }));
				console.error("Save failed:", err);
			} finally {
				savingRef.current = false;
				settle();
			}
		},
		[collection, entryId, field, getBlocks, loadError],
	);

	// Flush unsaved edits when the page goes away (browser back/forward,
	// link click, tab close). The blur handler doesn't cover this: unload
	// doesn't reliably fire React blur, and a plain fetch started during
	// unload is cancelled by the navigation — edits were silently lost.
	// `keepalive` lets the PUT outlive the page.
	// Caveat: keepalive caps the body at 64KB — a very long document
	// can still be lost on unload. Upgrade path: debounced autosave
	// while typing (like the admin editor) so unload flushes are rare.
	React.useEffect(() => {
		const flush = () => void save({ keepalive: true });
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [save]);

	// Create slash commands extension once — uses refs to avoid re-render loop
	const slashCommandsExtension = React.useMemo(
		() =>
			createSlashCommandsExtension({
				onStateChange: setSlashMenuState,
				getState: () => slashMenuStateRef.current,
				onCommand: (item) => slashMenuActionsRef.current.run(item),
				onDismiss: () => slashMenuActionsRef.current.dismiss(),
			}),
		[setSlashMenuState],
	);

	const editor = useEditor({
		extensions: [
			StarterKit.configure({
				dropcursor: { color: "#3b82f6", width: 2 },
				// Replaced with InlineCodeBlockExtension below (adds language picker).
				codeBlock: false,
				// Replaced with CodeMarkExtension so inline code can combine with link/etc.
				code: false,
				orderedList: false,
				// Registered on their own below, so links don't open when clicked.
				link: false,
				underline: false,
			}),
			EmDashOrderedList,
			CodeMarkExtension,
			InlineCodeBlockExtension,
			InlineImageExtension,
			Underline,
			Subscript,
			Superscript,
			Link.configure({
				openOnClick: false,
				// TipTap's Link extension defaults target to "_blank". Without an
				// explicit override it would deep-merge that default in, causing every
				// link created via setLink to serialize as blank: true.
				HTMLAttributes: { target: null, class: "underline text-blue-600 dark:text-blue-400" },
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
			HtmlBlockNode,
			TableBlockNode.configure({ placeholder: tablePlaceholder }),
			PluginBlockNode,
			slashCommandsExtension,
		],
		content: initialContent,
		immediatelyRender: false,
		editorProps: {
			attributes: {
				class: "prose prose-sm sm:prose-base dark:prose-invert max-w-none emdash-inline-editor",
				dir: "auto",
			},
			...unsupportedFileHandlers,
		},
		onUpdate: () => {
			document.dispatchEvent(new CustomEvent("emdash:save", { detail: { state: "unsaved" } }));
		},
	});

	// Store editor ref for getBlocks, and record the loaded document as saved.
	React.useEffect(() => {
		editorRef.current = editor;
		if (editor && !savedDocRef.current) savedDocRef.current = editor.state.doc;
	}, [editor]);

	const runSlashCommand = React.useCallback(
		(item: SlashCommandItem) => {
			const { range } = slashMenuStateRef.current;
			if (!editor || !range) return;
			item.command({
				editor,
				range,
				openImagePicker: () => setImagePickerAt(editor.state.selection.from),
			});
			setSlashMenuState((prev) => ({ ...prev, isOpen: false }));
		},
		[editor, setSlashMenuState],
	);
	/** Closes the slash menu without a command, keeping what was typed. */
	const closeSlashMenu = React.useCallback(() => {
		const { range } = slashMenuStateRef.current;
		setSlashMenuState((prev) => ({
			...prev,
			isOpen: false,
			dismissedSlashFrom: range ? range.from : prev.dismissedSlashFrom,
		}));
		if (editor && range) exitSuggestion(editor.view);
	}, [editor, setSlashMenuState]);
	slashMenuActionsRef.current = { run: runSlashCommand, dismiss: closeSlashMenu };

	// Edits made while the picker is open, as when focus stays in the editor, move the spot it inserts at.
	const pickerOpen = imagePickerAt !== null;
	React.useEffect(() => {
		if (!editor || !pickerOpen) return;
		const onTransaction = ({ transaction }: { transaction: Transaction }) => {
			if (!transaction.docChanged) return;
			setImagePickerAt((at) => (at === null ? at : transaction.mapping.map(at)));
		};
		editor.on("transaction", onTransaction);
		return () => {
			editor.off("transaction", onTransaction);
		};
	}, [editor, pickerOpen]);

	// The image picker opens at the caret the `/image` command left.
	const caretReference = React.useMemo(
		() =>
			editor && imagePickerAt !== null
				? {
						getBoundingClientRect: () => {
							if (editor.isDestroyed) return new DOMRect();
							const { view } = editor;
							const caret = view.coordsAtPos(Math.min(imagePickerAt, view.state.doc.content.size));
							return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
						},
						contextElement: editor.view.dom,
					}
				: null,
		[editor, imagePickerAt],
	);

	// Save on blur — but not when interacting with slash menu or image picker
	const handleBlur = React.useCallback(
		(e: React.FocusEvent<HTMLDivElement>) => {
			const related = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
			if (related && e.currentTarget.contains(related)) return;
			// The copy fallback briefly moves focus to its textarea before restoring the editor.
			if (related?.hasAttribute("data-emdash-clipboard-fallback")) return;
			// The toolbars, menus, and image picker live in a root of their own at the end of the page.
			if (related && uiRoot?.contains(related)) return;
			// A toolbar button keeps focus in the editor, so the toolbars skip
			// the editor's next blur; telling them again lets them hide. It waits
			// for this blur to finish, which may be a toolbar removing itself.
			const event = e.nativeEvent;
			queueMicrotask(() => {
				if (!editor || editor.isDestroyed || editor.view.hasFocus()) return;
				if (uiRoot?.contains(document.activeElement)) return;
				editor.view.dispatch(editor.state.tr.setMeta("blur", { event }));
			});
			void save();
		},
		[editor, save, uiRoot],
	);

	if (!editor || !uiRoot) return null;

	return (
		<div onBlur={handleBlur}>
			{loadError ? (
				<div className="emdash-inline-editor-error" role="alert" dir="auto">
					This field can’t be edited here because it contains unsupported Portable Text marks:{" "}
					{loadError.marks.join(", ")}.
				</div>
			) : (
				<>
					<InlineBubbleMenu editor={editor} uiRoot={uiRoot} onImageReplaced={() => void save()} />
					<EditorContent editor={editor} />
				</>
			)}
			{saveError ? (
				<div className="emdash-inline-editor-error" role="alert" dir="auto">
					{saveError}
				</div>
			) : null}
			{unsupportedFileGuidance ? (
				<div
					key={unsupportedFileGuidance.version}
					className="emdash-inline-editor-guidance"
					role="status"
					aria-live="polite"
					dir="auto"
				>
					{unsupportedFileGuidance.message}
				</div>
			) : null}
			<InlineSlashMenu
				editor={editor}
				uiRoot={uiRoot}
				state={slashMenuState}
				onCommand={runSlashCommand}
				onClose={closeSlashMenu}
				setSelectedIndex={(index) =>
					setSlashMenuState((prev) => ({ ...prev, selectedIndex: index }))
				}
			/>
			{imagePickerAt !== null && caretReference && (
				<InlineMediaPicker
					uiRoot={uiRoot}
					reference={caretReference}
					gap={6}
					label="Insert image"
					onChoose={(image) => {
						insertImage(editor, imagePickerAt, image);
						editor.view.focus();
						setImagePickerAt(null);
						void save();
					}}
					onClose={(reason) => {
						if (reason !== "blur") editor.view.focus();
						setImagePickerAt(null);
					}}
				/>
			)}
			<style>{`
				.emdash-inline-code-block {
					position: relative;
					margin-block: 1rem;
					--emdash-code-background: var(--emdash-inline-code-background, #f7f7f5);
					--emdash-code-foreground: var(--emdash-inline-code-foreground, #24292f);
					--emdash-code-muted: var(--emdash-inline-code-muted, #57606a);
					--emdash-code-keyword: var(--emdash-inline-code-keyword, #b8172a);
					--emdash-code-string: var(--emdash-inline-code-string, #0a3069);
					--emdash-code-number: var(--emdash-inline-code-number, #0550ae);
					--emdash-code-title: var(--emdash-inline-code-title, #7545c7);
					--emdash-code-border: var(--emdash-inline-code-border, #7d8590);
					--emdash-code-control-background: var(
						--emdash-inline-code-control-background,
						var(--emdash-inline-bg, #ffffff)
					);
					--emdash-code-control-foreground: var(
						--emdash-inline-code-control-foreground,
						#24292f
					);
					--emdash-code-focus: var(--emdash-inline-code-focus, #0550ae);
				}
				.emdash-inline-code-block .emdash-code-block {
					margin: 0;
					padding: 1rem;
					padding-block: 30px !important;
					border: 0 !important;
					border-radius: 0.5rem;
					background: var(--emdash-code-background) !important;
					color: var(--emdash-code-foreground) !important;
					caret-color: var(--emdash-code-foreground) !important;
					overflow-x: auto;
				}
				.emdash-inline-code-block .emdash-code-block code {
					background: transparent !important;
					color: inherit !important;
					font-size: 13px !important;
				}
				.emdash-inline-code-block :is(.hljs-comment, .hljs-quote) {
					color: var(--emdash-code-muted);
				}
				.emdash-inline-code-block
					:is(.hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-section, .hljs-link, .hljs-deletion) {
					color: var(--emdash-code-keyword);
				}
				.emdash-inline-code-block
					:is(.hljs-string, .hljs-attr, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition) {
					color: var(--emdash-code-string);
				}
				.emdash-inline-code-block :is(.hljs-number, .hljs-meta) {
					color: var(--emdash-code-number);
				}
				.emdash-inline-code-block
					:is(.hljs-title, .hljs-name, .hljs-type, .hljs-built_in, .hljs-selector-id, .hljs-selector-class) {
					color: var(--emdash-code-title);
				}
				.emdash-inline-code-block-popover,
				.emdash-inline-code-block-chip {
					box-sizing: border-box;
					border: 1px solid var(--emdash-code-border);
					background: var(--emdash-code-control-background);
					color: var(--emdash-code-control-foreground);
				}
				.emdash-inline-code-block-controls-wrap {
					position: absolute;
					inset-block-start: 0;
					inset-inline-end: 0.25rem;
					z-index: 100;
					max-inline-size: min(calc(100% - 0.25rem), calc(100vw - 1rem));
					opacity: 0;
					pointer-events: none;
					user-select: none;
					transition: opacity 120ms ease-out;
				}
				.emdash-inline-code-block:hover .emdash-inline-code-block-controls-wrap,
				.emdash-inline-code-block:focus-within .emdash-inline-code-block-controls-wrap,
				.emdash-inline-code-block-controls-wrap[data-persistent="true"] {
					opacity: 1;
					pointer-events: auto;
				}
				.emdash-inline-code-block-popover {
					inline-size: min(14rem, 100%, calc(100vw - 1rem));
				}
				.emdash-inline-code-block-language-input {
					min-inline-size: 0;
					flex: 1;
					border: 1px solid var(--emdash-code-border);
					background: transparent;
					color: inherit;
				}
				.emdash-inline-code-block-controls-wrap button:focus-visible,
				.emdash-inline-code-block-language-input:focus-visible {
					outline: 2px solid var(--emdash-code-focus);
					outline-offset: 2px;
				}
				@media (hover: none), (pointer: coarse) {
					.emdash-inline-code-block-controls-wrap {
						opacity: 1;
						pointer-events: auto;
					}
				}
				@media (prefers-reduced-motion: reduce) {
					.emdash-inline-code-block-controls-wrap {
						transition: none;
					}
				}
				@media (prefers-color-scheme: dark) {
					.emdash-inline-code-block {
						--emdash-code-background: var(--emdash-inline-code-background, #202020);
						--emdash-code-foreground: var(--emdash-inline-code-foreground, #f0f3f6);
						--emdash-code-muted: var(--emdash-inline-code-muted, #c9d1d9);
						--emdash-code-keyword: var(--emdash-inline-code-keyword, #ffc1bb);
						--emdash-code-string: var(--emdash-inline-code-string, #b9ddff);
						--emdash-code-number: var(--emdash-inline-code-number, #a8d5ff);
						--emdash-code-title: var(--emdash-inline-code-title, #e5ccff);
						--emdash-code-border: var(--emdash-inline-code-border, #6e7681);
						--emdash-code-control-background: var(
							--emdash-inline-code-control-background,
							var(--emdash-inline-bg, #161b22)
						);
						--emdash-code-control-foreground: var(
							--emdash-inline-code-control-foreground,
							#f0f3f6
						);
						--emdash-code-focus: var(--emdash-inline-code-focus, #a8d5ff);
					}
				}
				.emdash-inline-editor .emdash-slash-query {
					margin-inline: -0.25em;
					padding: 0.125em 0.25em;
					border-radius: 0.375rem;
					background: color-mix(in srgb, currentColor 8%, transparent);
				}
				.emdash-inline-editor .emdash-slash-query.is-empty::after {
					content: "Type to search";
					color: color-mix(in srgb, currentColor 45%, transparent);
					pointer-events: none;
				}
				${INLINE_EDITOR_UI_STYLES}
				${INLINE_MEDIA_PICKER_STYLES}
				${INLINE_IMAGE_STYLES}
				.emdash-inline-editor:focus {
					outline: none;
				}
				.emdash-inline-editor:focus p.is-editor-empty {
					display: flow-root;
				}
				.emdash-inline-editor:focus p.is-editor-empty::before {
					content: attr(data-placeholder);
					float: inline-start;
					width: 100%;
					margin-inline-end: -100%;
					opacity: 0.5;
					pointer-events: none;
				}
				.emdash-inline-editor-guidance {
					margin-block-start: 0.75rem;
					padding-block: 0.625rem;
					padding-inline: 0.875rem;
					border: 1px solid #bfdbfe;
					border-radius: 0.5rem;
					background: #eff6ff;
					color: #1e3a8a;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					line-height: 1.4;
					text-align: start;
				}
				.emdash-inline-editor-error {
					margin-block-start: 0.75rem;
					padding-block: 0.625rem;
					padding-inline: 0.875rem;
					border: 1px solid #fecaca;
					border-radius: 0.5rem;
					background: #fef2f2;
					color: #991b1b;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					line-height: 1.4;
					text-align: start;
				}
				.emdash-plugin-block-placeholder {
					margin: 0.75rem 0;
					padding: 0.625rem 0.875rem;
					border: 1px dashed #d1d5db;
					border-radius: 0.5rem;
					background: #f9fafb;
					color: #4b5563;
					font-size: 0.875rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
					user-select: none;
				}
				@media (prefers-color-scheme: dark) {
					.emdash-inline-editor-guidance {
						border-color: #1e40af;
						background: #172554;
						color: #dbeafe;
					}
					.emdash-inline-editor-error {
						border-color: #991b1b;
						background: #450a0a;
						color: #fee2e2;
					}
					.emdash-plugin-block-placeholder {
						border-color: #374151;
						background: #111827;
						color: #9ca3af;
					}
				}
			`}</style>
		</div>
	);
}

// Test-only exports for unit tests.
export { pmToPortableText as _pmToPortableText };
export { portableTextToPM as _portableTextToPM };
export { createUnsupportedFileHandlers as _createUnsupportedFileHandlers };
export { TableBlockNode as _InlineTableBlockNode };
