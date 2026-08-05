/**
 * Portable Text <-> Markdown conversion layer.
 *
 * Three tiers of block handling:
 *   Tier 1: Standard PT blocks <-> standard Markdown (headings, paragraphs, lists, etc.)
 *   Tier 2: EmDash custom blocks <-> Markdown directives (future)
 *   Tier 3: Unknown blocks <-> opaque HTML comment fences (preserved, not editable)
 */

import { normalizeListId, normalizeListStart } from "../content/converters/numbered-list.js";
import { getNumberedListOrdinals } from "../content/portable-text-lists.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal Portable Text block shape */
export interface PortableTextBlock {
	_type: string;
	_key?: string;
	style?: string;
	level?: number;
	listItem?: string;
	listId?: string;
	listStart?: number;
	markDefs?: MarkDef[];
	children?: PortableTextSpan[];
	[key: string]: unknown;
}

interface PortableTextSpan {
	_type: string;
	_key?: string;
	text?: string;
	marks?: string[];
	[key: string]: unknown;
}

interface MarkDef {
	_key: string;
	_type: string;
	href?: string;
	[key: string]: unknown;
}

interface ParsedInline {
	spans: PortableTextSpan[];
	markDefs: MarkDef[];
}

// ---------------------------------------------------------------------------
// PT -> Markdown
// ---------------------------------------------------------------------------

/**
 * Convert Portable Text blocks to Markdown.
 * Unknown block types are serialized as opaque fences.
 */
export function portableTextToMarkdown(blocks: PortableTextBlock[]): string {
	const lines: string[] = [];
	const ordinals = getNumberedListOrdinals(blocks);
	let prevWasList = false;

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		if (block._type === "block") {
			const isList = !!block.listItem;
			const previous = blocks[i - 1];
			const independentNumberedRun =
				isList && previous ? startsIndependentNumberedRun(previous, block) : false;

			// Blank line between non-contiguous block types
			if (i > 0 && (!isList || !prevWasList || independentNumberedRun)) {
				lines.push("");
			}

			lines.push(renderStandardBlock(block, ordinals.get(block)));
			prevWasList = isList;
		} else if (block._type === "code") {
			if (i > 0) lines.push("");
			const lang = (block.language as string) || "";
			const code = (block.code as string) || "";
			lines.push("```" + lang);
			lines.push(code);
			lines.push("```");
			prevWasList = false;
		} else if (block._type === "image") {
			if (i > 0) lines.push("");
			const alt = (block.alt as string) || "";
			const url = (block.asset as { url?: string })?.url || "";
			lines.push(`![${alt}](${url})`);
			prevWasList = false;
		} else {
			// Tier 3: Unknown block -> opaque fence
			if (i > 0) lines.push("");
			lines.push(`<!--ec:block ${JSON.stringify(block)} -->`);
			prevWasList = false;
		}
	}

	return lines.join("\n") + "\n";
}

function startsIndependentNumberedRun(
	previous: PortableTextBlock,
	current: PortableTextBlock,
): boolean {
	if (previous.listItem !== "number" || current.listItem !== "number") return false;
	if ((previous.level ?? 1) !== (current.level ?? 1)) return false;
	return normalizeListId(previous.listId) !== normalizeListId(current.listId);
}

function renderStandardBlock(block: PortableTextBlock, ordinal?: number): string {
	const text = renderSpans(block.children ?? [], block.markDefs ?? []);

	// List items
	if (block.listItem) {
		const indent = "  ".repeat(Math.max(0, (block.level ?? 1) - 1));
		const marker = block.listItem === "number" ? `${ordinal ?? 1}.` : "-";
		return `${indent}${marker} ${text}`;
	}

	// Headings
	if (block.style && block.style.startsWith("h")) {
		const level = parseInt(block.style.substring(1), 10);
		if (level >= 1 && level <= 6) {
			return `${"#".repeat(level)} ${text}`;
		}
	}

	// Blockquote
	if (block.style === "blockquote") {
		return `> ${text}`;
	}

	return text;
}

function renderSpans(spans: PortableTextSpan[], markDefs: MarkDef[]): string {
	let result = "";

	for (const span of spans) {
		if (span._type !== "span") continue;

		let text = span.text ?? "";
		const marks = span.marks ?? [];

		for (const mark of marks) {
			const def = markDefs.find((d) => d._key === mark);
			if (def) {
				if (def._type === "link") {
					text = `[${text}](${def.href ?? ""})`;
				}
			} else {
				switch (mark) {
					case "strong":
						text = `**${text}**`;
						break;
					case "em":
						text = `_${text}_`;
						break;
					case "code":
						text = `\`${text}\``;
						break;
					case "strike-through":
					case "strikethrough":
						text = `~~${text}~~`;
						break;
				}
			}
		}

		result += text;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Markdown -> PT
// ---------------------------------------------------------------------------

// Regex patterns for markdown parsing
const OPAQUE_FENCE_PATTERN = /^<!--ec:block (.+) -->$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_PATTERN = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^(\s*)(\d+)\.\s+(.+)$/;
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const INLINE_MARKDOWN_PATTERN =
	/(\*\*(.+?)\*\*)|(_(.+?)_)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))|(~~(.+?)~~)/g;

/**
 * Convert Markdown to Portable Text blocks.
 * Opaque fences (<!--ec:block ... -->) are deserialized and spliced back in.
 */
export function markdownToPortableText(markdown: string): PortableTextBlock[] {
	const blocks: PortableTextBlock[] = [];
	const lines = markdown.split("\n");
	const orderedGroups = new Map<string, { listId: string; listStart: number }>();
	const lastListItems = new Map<number, string>();
	const lastListTypes = new Map<number, string>();
	const resetListState = () => {
		orderedGroups.clear();
		lastListItems.clear();
		lastListTypes.clear();
	};
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// Opaque fence
		const opaqueMatch = line.match(OPAQUE_FENCE_PATTERN);
		if (opaqueMatch) {
			resetListState();
			try {
				blocks.push(JSON.parse(opaqueMatch[1]) as PortableTextBlock);
			} catch {
				blocks.push(makeBlock(line));
			}
			i++;
			continue;
		}

		// Code fence
		if (line.startsWith("```")) {
			resetListState();
			const lang = line.slice(3).trim();
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				codeLines.push(lines[i]);
				i++;
			}
			blocks.push({
				_type: "code",
				_key: generateKey(),
				language: lang || undefined,
				code: codeLines.join("\n"),
			});
			i++; // skip closing ```
			continue;
		}

		// Blank line
		if (line.trim() === "") {
			resetListState();
			i++;
			continue;
		}

		// Heading
		const headingMatch = line.match(HEADING_PATTERN);
		if (headingMatch) {
			resetListState();
			blocks.push(makeBlock(headingMatch[2], `h${headingMatch[1].length}`));
			i++;
			continue;
		}

		// Blockquote
		if (line.startsWith("> ")) {
			resetListState();
			blocks.push(makeBlock(line.slice(2), "blockquote"));
			i++;
			continue;
		}

		// Unordered list
		const ulMatch = line.match(UNORDERED_LIST_PATTERN);
		if (ulMatch) {
			const level = Math.floor(ulMatch[1].length / 2) + 1;
			for (const itemLevel of lastListItems.keys()) {
				if (itemLevel > level) lastListItems.delete(itemLevel);
			}
			for (const typeLevel of lastListTypes.keys()) {
				if (typeLevel > level) lastListTypes.delete(typeLevel);
			}
			const block = makeListBlock(ulMatch[2], "bullet", level);
			blocks.push(block);
			lastListItems.set(level, block._key!);
			lastListTypes.set(level, "bullet");
			i++;
			continue;
		}

		// Ordered list
		const olMatch = line.match(ORDERED_LIST_PATTERN);
		if (olMatch) {
			const level = Math.floor(olMatch[1].length / 2) + 1;
			for (const itemLevel of lastListItems.keys()) {
				if (itemLevel > level) lastListItems.delete(itemLevel);
			}
			for (const typeLevel of lastListTypes.keys()) {
				if (typeLevel > level) lastListTypes.delete(typeLevel);
			}
			let parentContext = "root";
			for (let parentLevel = level - 1; parentLevel >= 1; parentLevel--) {
				const parent = lastListItems.get(parentLevel);
				if (!parent) continue;
				parentContext = parent;
				break;
			}
			const groupKey = JSON.stringify([level, parentContext]);
			let group = orderedGroups.get(groupKey);
			if (!group || lastListTypes.get(level) !== "number") {
				group = {
					listId: createListId(),
					listStart: normalizeListStart(Number(olMatch[2])) ?? 1,
				};
				orderedGroups.set(groupKey, group);
			}
			const block = makeListBlock(olMatch[3], "number", level);
			block.listId = group.listId;
			block.listStart = group.listStart;
			blocks.push(block);
			lastListItems.set(level, block._key!);
			lastListTypes.set(level, "number");
			i++;
			continue;
		}

		// Image
		const imgMatch = line.match(IMAGE_PATTERN);
		if (imgMatch) {
			resetListState();
			blocks.push({
				_type: "image",
				_key: generateKey(),
				alt: imgMatch[1],
				asset: { url: imgMatch[2] },
			});
			i++;
			continue;
		}

		// Paragraph
		resetListState();
		blocks.push(makeBlock(line));
		i++;
	}

	return blocks;
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

function makeBlock(text: string, style: string = "normal"): PortableTextBlock {
	const { spans, markDefs } = parseInline(text);
	return { _type: "block", _key: generateKey(), style, markDefs, children: spans };
}

function makeListBlock(text: string, listItem: string, level: number): PortableTextBlock {
	const { spans, markDefs } = parseInline(text);
	return {
		_type: "block",
		_key: generateKey(),
		style: "normal",
		listItem,
		level,
		markDefs,
		children: spans,
	};
}

function createListId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	);
}

/**
 * Parse inline markdown (bold, italic, code, links, strikethrough) into PT spans + markDefs.
 */
function parseInline(text: string): ParsedInline {
	const spans: PortableTextSpan[] = [];
	const markDefs: MarkDef[] = [];
	const regex = INLINE_MARKDOWN_PATTERN;

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: text.slice(lastIndex, match.index),
				marks: [],
			});
		}

		if (match[2] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: match[2], marks: ["strong"] });
		} else if (match[4] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: match[4], marks: ["em"] });
		} else if (match[6] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: match[6], marks: ["code"] });
		} else if (match[8] != null && match[9] != null) {
			const key = generateKey();
			markDefs.push({ _key: key, _type: "link", href: match[9] });
			spans.push({ _type: "span", _key: generateKey(), text: match[8], marks: [key] });
		} else if (match[11] != null) {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: match[11],
				marks: ["strike-through"],
			});
		}

		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		spans.push({ _type: "span", _key: generateKey(), text: text.slice(lastIndex), marks: [] });
	}

	if (spans.length === 0) {
		spans.push({ _type: "span", _key: generateKey(), text, marks: [] });
	}

	return { spans, markDefs };
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

let keyCounter = 0;

function generateKey(): string {
	return `k${(keyCounter++).toString(36)}`;
}

/** Reset key counter (useful for testing) */
export function resetKeyCounter(): void {
	keyCounter = 0;
}

// ---------------------------------------------------------------------------
// Schema-aware conversion helpers
// ---------------------------------------------------------------------------

export interface FieldSchema {
	slug: string;
	type: string;
}

/**
 * Convert content data for reading: PT fields -> markdown strings.
 * Only converts fields with type "portableText" that contain arrays.
 */
export function convertDataForRead(
	data: Record<string, unknown>,
	fields: FieldSchema[],
	raw: boolean = false,
): Record<string, unknown> {
	if (raw) return data;

	const result = { ...data };
	for (const field of fields) {
		if (field.type === "portableText" && Array.isArray(result[field.slug])) {
			result[field.slug] = portableTextToMarkdown(result[field.slug] as PortableTextBlock[]);
		}
	}
	return result;
}

/**
 * Convert content data for writing: markdown strings -> PT arrays.
 * Only converts fields with type "portableText" that contain strings.
 */
export function convertDataForWrite(
	data: Record<string, unknown>,
	fields: FieldSchema[],
): Record<string, unknown> {
	const result = { ...data };
	for (const field of fields) {
		if (field.type === "portableText" && typeof result[field.slug] === "string") {
			result[field.slug] = markdownToPortableText(result[field.slug] as string);
		}
	}
	return result;
}
