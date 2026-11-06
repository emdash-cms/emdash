/**
 * Portable Text <-> Markdown conversion layer.
 *
 * Three tiers of block handling:
 *   Tier 1: Standard PT blocks <-> standard Markdown (headings, paragraphs, lists, etc.)
 *   Tier 2: EmDash custom blocks <-> Markdown directives (future)
 *   Tier 3: Unknown blocks <-> opaque HTML comment fences (preserved, not editable)
 */

import { Marked, type MarkedToken, type Tokens } from "marked";

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
	let prevWasList = false;
	const listWidths: number[] = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		if (block._type === "block") {
			const isList = !!block.listItem;

			// Blank line between non-contiguous block types
			if (i > 0 && (!isList || !prevWasList)) {
				lines.push("");
			}

			const level = Math.max(1, block.level ?? 1);
			const indent = Array.from({ length: level - 1 }, (_, index) => listWidths[index] ?? 2).reduce(
				(sum, width) => sum + width,
				0,
			);
			listWidths[level - 1] = block.listItem === "number" ? 3 : 2;
			listWidths.length = isList ? level : 0;
			lines.push(renderStandardBlock(block, indent));
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
		} else if (block._type === "table") {
			if (i > 0) lines.push("");
			lines.push(renderTable(block) ?? `<!--ec:block ${JSON.stringify(block)} -->`);
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

const LINE_BREAK_PATTERN = /[\n\r]/;
const CODE_EDGE_PATTERN = /^`|`$/;
const PADDED_CODE_PATTERN = /^ .* $/;
const CODE_PIPE_PATTERN = /\\\|/;

interface MarkdownTableCell {
	_type: string;
	content: PortableTextSpan[];
	markDefs?: MarkDef[];
	isHeader?: boolean;
	colspan?: number;
	rowspan?: number;
	colwidth?: unknown;
	textAlign?: string;
}

const TABLE_FIELDS = new Set(["_type", "_key", "rows", "hasHeaderRow", "markDefs"]);
const ROW_FIELDS = new Set(["_type", "_key", "cells"]);
const CELL_FIELDS = new Set([
	"_type",
	"_key",
	"content",
	"markDefs",
	"isHeader",
	"colspan",
	"rowspan",
	"colwidth",
	"textAlign",
]);
const SPAN_FIELDS = new Set(["_type", "_key", "text", "marks"]);
const LINK_FIELDS = new Set(["_type", "_key", "href"]);
const MARKDOWN_MARKS = new Set(["strong", "em", "code", "strike-through", "strikethrough"]);

function hasOnlyFields(value: object, fields: Set<string>): boolean {
	return Object.keys(value).every((key) => fields.has(key));
}

function canRenderMarkDefs(defs: MarkDef[]): boolean {
	return defs.every(
		(def) =>
			def?._type === "link" &&
			hasOnlyFields(def, LINK_FIELDS) &&
			!def.href?.includes("\\") &&
			!def.href?.includes("|"),
	);
}

function renderTable(block: PortableTextBlock): string | undefined {
	if (
		!Array.isArray(block.rows) ||
		!block.rows.length ||
		!hasOnlyFields(block, TABLE_FIELDS) ||
		!canRenderMarkDefs(block.markDefs ?? [])
	)
		return undefined;
	const rows = block.rows as Array<{ cells?: MarkdownTableCell[] }>;
	const width = rows[0]?.cells?.length;
	if (!width || !block.hasHeaderRow) return undefined;
	const rendered: string[] = [];
	for (const [index, row] of rows.entries()) {
		if (!Array.isArray(row?.cells) || row.cells.length !== width || !hasOnlyFields(row, ROW_FIELDS))
			return undefined;
		const cells: string[] = [];
		for (const [column, cell] of row.cells.entries()) {
			// GFM cannot represent merged cells, per-row alignment, or column widths.
			if (
				!cell ||
				cell._type !== "tableCell" ||
				!hasOnlyFields(cell, CELL_FIELDS) ||
				!canRenderMarkDefs(cell.markDefs ?? []) ||
				!Array.isArray(cell.content) ||
				(cell.colspan ?? 1) !== 1 ||
				(cell.rowspan ?? 1) !== 1 ||
				cell.colwidth ||
				(cell.isHeader ?? index === 0) !== (index === 0) ||
				cell.textAlign !== rows[0]?.cells?.[column]?.textAlign ||
				cell.textAlign === "justify" ||
				cell.content.some(
					(span) =>
						!span ||
						span._type !== "span" ||
						!hasOnlyFields(span, SPAN_FIELDS) ||
						LINE_BREAK_PATTERN.test(span.text ?? "") ||
						span.marks?.some(
							(mark) =>
								!MARKDOWN_MARKS.has(mark) &&
								![...(cell.markDefs ?? []), ...(block.markDefs ?? [])].some(
									(def) => def._key === mark && def._type === "link",
								),
						),
				)
			)
				return undefined;
			const text = cell.content.map((span) => span.text ?? "").join("");
			if (
				text !== text.trim() ||
				coalesceSpans(cell.content).some(
					(span) => span.marks?.includes("code") && CODE_PIPE_PATTERN.test(span.text ?? ""),
				)
			)
				return undefined;
			cells.push(
				renderSpans(cell.content, [...(cell.markDefs ?? []), ...(block.markDefs ?? [])]).replaceAll(
					"|",
					"\\|",
				),
			);
		}
		rendered.push(`| ${cells.join(" | ")} |`);
		if (index === 0) {
			rendered.push(
				`| ${row.cells.map((cell) => (cell.textAlign === "center" ? ":---:" : cell.textAlign === "right" ? "---:" : cell.textAlign === "left" ? ":---" : "---")).join(" | ")} |`,
			);
		}
	}
	return rendered.join("\n");
}

function renderStandardBlock(block: PortableTextBlock, indentation = 0): string {
	const text = renderSpans(block.children ?? [], block.markDefs ?? []);

	// List items
	if (block.listItem) {
		const indent = " ".repeat(indentation);
		const marker = block.listItem === "number" ? "1." : "-";
		return `${indent}${marker} ${text.replaceAll("\n", `\n${indent}${" ".repeat(marker.length + 1)}`)}`;
	}

	// Headings
	if (block.style && block.style.startsWith("h")) {
		const level = parseInt(block.style.substring(1), 10);
		if (level >= 1 && level <= 6) {
			if (
				block.children?.some(
					(span) => span._type === "span" && LINE_BREAK_PATTERN.test(span.text ?? ""),
				)
			) {
				return `<!--ec:block ${JSON.stringify(block)} -->`;
			}
			return `${"#".repeat(level)} ${text}`;
		}
	}

	// Blockquote
	if (block.style === "blockquote") {
		return `> ${text.replaceAll("\n", "\n> ")}`;
	}

	return text;
}

function wrapMark(text: string, delimiter: string): string {
	const trimmed = text.trim();
	if (!trimmed) return text;
	const start = text.length - text.trimStart().length;
	return `${text.slice(0, start)}${delimiter}${trimmed}${delimiter}${text.slice(start + trimmed.length)}`;
}

function coalesceSpans(spans: PortableTextSpan[]): PortableTextSpan[] {
	const runs: PortableTextSpan[] = [];
	for (const span of spans) {
		const previous = runs.at(-1);
		const marks = [...new Set(span.marks ?? [])];
		if (
			span._type === "span" &&
			previous?._type === "span" &&
			marks.length === previous.marks?.length &&
			marks.every((mark) => previous.marks?.includes(mark))
		) {
			previous.text = (previous.text ?? "") + (span.text ?? "");
		} else {
			runs.push({ ...span, marks });
		}
	}
	return runs;
}

function renderSpans(spans: PortableTextSpan[], markDefs: MarkDef[]): string {
	let result = "";

	for (const span of coalesceSpans(spans)) {
		if (span._type !== "span") continue;

		const marks = span.marks ?? [];
		const normalized = (span.text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
		const value = marks.includes("code") ? normalized.replaceAll("\n", " ") : normalized;
		let text: string;
		if (marks.includes("code")) {
			const runs = value.match(/`+/g) ?? [];
			const fence = "`".repeat(runs.reduce((max, run) => Math.max(max, run.length), 0) + 1);
			const padding =
				CODE_EDGE_PATTERN.test(value) || (PADDED_CODE_PATTERN.test(value) && value.trim())
					? " "
					: "";
			text = `${fence}${padding}${value}${padding}${fence}`;
		} else {
			text = value.replace(/[\\`*_[\]<>~]/g, "\\$&");
		}
		for (const mark of marks) {
			switch (mark) {
				case "strong":
					text = wrapMark(text, "**");
					break;
				case "em":
					text = wrapMark(text, "*");
					break;
				case "strike-through":
				case "strikethrough":
					text = wrapMark(text, "~~");
					break;
			}
		}
		for (const mark of marks) {
			const def = markDefs.find((candidate) => candidate._key === mark);
			if (def?._type === "link") text = `[${text}](${def.href ?? ""})`;
		}

		result += text;
	}

	let end = result.length;
	while (end > 0 && result[end - 1] === "\n") end--;
	return result.slice(0, end).replaceAll("\n", "\\\n");
}

// ---------------------------------------------------------------------------
// Markdown -> PT
// ---------------------------------------------------------------------------

let markdownLexer: Marked | undefined;
const OPAQUE_FENCE_PATTERN = /^<!--ec:block (.+) -->$/;

/**
 * Convert Markdown to Portable Text blocks.
 * Opaque fences (<!--ec:block ... -->) are deserialized and spliced back in.
 */
export function markdownToPortableText(markdown: string): PortableTextBlock[] {
	markdownLexer ??= new Marked({ gfm: true, tokenizer: { url: () => undefined } });
	return convertTokens(markdownLexer.lexer(markdown) as MarkedToken[]);
}

function convertTokens(
	tokens: MarkedToken[],
	level = 0,
	splitParagraphImages = true,
): PortableTextBlock[] {
	const blocks: PortableTextBlock[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "space":
			case "def":
			case "checkbox":
				break;
			case "heading":
				blocks.push(makeBlock(token.tokens as MarkedToken[], `h${token.depth}`));
				break;
			case "paragraph":
			case "text": {
				const inline = token.tokens as MarkedToken[] | undefined;
				const children = inline ?? [{ type: "text" as const, raw: token.text, text: token.text }];
				const parts = splitParagraphImages ? splitInlineImages(children) : [children];
				for (const part of parts) {
					if (Array.isArray(part)) {
						const block = makeBlock(part);
						if (parts.length > 1) {
							const first = block.children?.[0];
							const last = block.children?.at(-1);
							if (first && !first.marks?.length) first.text = first.text?.trimStart();
							if (last && !last.marks?.length) last.text = last.text?.trimEnd();
						}
						if (block.children?.some((span) => span.text)) blocks.push(block);
					} else {
						blocks.push({
							_type: "image",
							_key: generateKey(),
							alt: part.text,
							asset: { url: part.href },
						});
					}
				}
				break;
			}
			case "blockquote":
				for (const block of convertTokens(token.tokens as MarkedToken[], level, false)) {
					if (block._type === "block") block.style = "blockquote";
					blocks.push(block);
				}
				break;
			case "list":
				for (const item of token.items) {
					let first = true;
					for (const block of convertTokens(item.tokens as MarkedToken[], level + 1, false)) {
						if (first && block._type === "block" && !block.listItem) {
							block.listItem = token.ordered ? "number" : "bullet";
							block.level = level + 1;
							if (item.tokens[0]?.type === "checkbox") {
								block.children?.unshift({
									_type: "span",
									_key: generateKey(),
									text: item.tokens[0].raw,
									marks: [],
								});
							}
						}
						first = false;
						blocks.push(block);
					}
				}
				break;
			case "code":
				blocks.push({
					_type: "code",
					_key: generateKey(),
					language: token.lang || undefined,
					code: token.text,
				});
				break;
			case "table":
				blocks.push({
					_type: "table",
					_key: generateKey(),
					hasHeaderRow: true,
					rows: [token.header, ...token.rows].map((row, index) => ({
						_type: "tableRow",
						_key: generateKey(),
						cells: row.map((cell, column) => {
							const { spans, markDefs } = parseInline(cell.tokens as MarkedToken[]);
							return {
								_type: "tableCell",
								_key: generateKey(),
								content: spans,
								markDefs,
								isHeader: index === 0,
								...(token.align[column] ? { textAlign: token.align[column] } : {}),
							};
						}),
					})),
				});
				break;
			case "html":
				// Marked can group adjacent comments into one HTML token.
				for (const line of token.raw.trimEnd().split("\n")) {
					const match = line.match(OPAQUE_FENCE_PATTERN);
					if (match) {
						try {
							blocks.push(JSON.parse(match[1]) as PortableTextBlock);
							continue;
						} catch {
							/* Preserve malformed fences as literal text. */
						}
					}
					blocks.push(makeBlock([{ type: "text", raw: line, text: line }]));
				}
				break;
			default:
				blocks.push(makeBlock([{ type: "text", raw: token.raw, text: token.raw.trimEnd() }]));
		}
	}
	return blocks;
}

function splitInlineImages(tokens: MarkedToken[]): Array<MarkedToken[] | Tokens.Image> {
	const parts: Array<MarkedToken[] | Tokens.Image> = [];
	let pending: MarkedToken[] = [];
	function appendImage(image: Tokens.Image): void {
		if (pending.length) parts.push(pending);
		pending = [];
		parts.push(image);
	}
	for (const token of tokens) {
		if (token.type === "image") {
			appendImage(token);
		} else if (
			(token.type === "strong" ||
				token.type === "em" ||
				token.type === "del" ||
				token.type === "text") &&
			token.tokens
		) {
			for (const part of splitInlineImages(token.tokens as MarkedToken[])) {
				if (Array.isArray(part)) pending.push({ ...token, tokens: part });
				else appendImage(part);
			}
		} else {
			pending.push(token);
		}
	}
	if (pending.length) parts.push(pending);
	return parts;
}

function makeBlock(tokens: MarkedToken[], style = "normal"): PortableTextBlock {
	const { spans, markDefs } = parseInline(tokens);
	return { _type: "block", _key: generateKey(), style, markDefs, children: spans };
}

function parseInline(tokens: MarkedToken[]): ParsedInline {
	const spans: PortableTextSpan[] = [];
	const markDefs: MarkDef[] = [];
	const append = (text: string, marks: string[]) => {
		spans.push({ _type: "span", _key: generateKey(), text, marks });
	};
	function visit(children: MarkedToken[], marks: string[] = []): void {
		for (const token of children) {
			switch (token.type) {
				case "strong":
				case "em":
				case "del":
					visit(token.tokens as MarkedToken[], [
						...marks,
						token.type === "del" ? "strike-through" : token.type,
					]);
					break;
				case "link": {
					const key = generateKey();
					markDefs.push({ _type: "link", _key: key, href: token.href });
					visit(token.tokens as MarkedToken[], [...marks, key]);
					break;
				}
				case "codespan":
					append(token.text, [...marks, "code"]);
					break;
				case "br":
					append("\n", marks);
					break;
				case "text":
					if (token.tokens) visit(token.tokens as MarkedToken[], marks);
					else append(token.text.replaceAll("\n", " "), marks);
					break;
				case "escape":
					append(token.text, marks);
					break;
				default:
					append(token.raw, marks);
			}
		}
	}
	visit(tokens);
	if (!spans.length) append("", []);
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
	validation?: unknown;
	blockTypes?: Array<{
		slug: string;
		currentVersion: number;
		versions: Array<{
			version: number;
			fields: Array<{ slug: string; type: string }>;
		}>;
	}>;
}

function convertNestedBlockPortableText(
	value: unknown,
	field: FieldSchema,
	direction: "read" | "write",
): unknown {
	if (!Array.isArray(value)) return value;
	const validation = field.validation;
	const allowedTypes =
		validation && typeof validation === "object" && "allowedTypes" in validation
			? validation.allowedTypes
			: undefined;
	return value.map((block) => {
		if (!block || typeof block !== "object" || Array.isArray(block)) return block;
		const record = { ...block };
		const type =
			record._type === undefined &&
			direction === "write" &&
			Array.isArray(allowedTypes) &&
			allowedTypes.length === 1
				? allowedTypes[0]
				: record._type;
		const version = typeof record._version === "number" ? record._version : undefined;
		const blockType = field.blockTypes?.find((candidate) => candidate.slug === type);
		const definition = blockType?.versions.find(
			(candidate) => candidate.version === (version ?? blockType.currentVersion),
		);
		if (!definition) return block;
		for (const nestedField of definition.fields) {
			if (nestedField.type !== "portableText") continue;
			const nestedValue = record[nestedField.slug];
			if (direction === "read" && Array.isArray(nestedValue)) {
				record[nestedField.slug] = portableTextToMarkdown(nestedValue as PortableTextBlock[]);
			} else if (direction === "write" && typeof nestedValue === "string") {
				record[nestedField.slug] = markdownToPortableText(nestedValue);
			}
		}
		return record;
	});
}

/**
 * Convert content data for reading: Portable Text arrays -> Markdown strings.
 * Converts top-level `portableText` arrays and nested `portableText` arrays
 * inside `blocks` arrays.
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
		} else if (field.type === "blocks" && Array.isArray(result[field.slug])) {
			result[field.slug] = convertNestedBlockPortableText(result[field.slug], field, "read");
		}
	}
	return result;
}

/**
 * Convert content data for writing: Markdown strings -> Portable Text arrays.
 * Converts top-level `portableText` strings and nested Markdown strings
 * in `portableText` fields inside `blocks` arrays.
 */
export function convertDataForWrite(
	data: Record<string, unknown>,
	fields: FieldSchema[],
): Record<string, unknown> {
	const result = { ...data };
	for (const field of fields) {
		if (field.type === "portableText" && typeof result[field.slug] === "string") {
			result[field.slug] = markdownToPortableText(result[field.slug] as string);
		} else if (field.type === "blocks" && Array.isArray(result[field.slug])) {
			result[field.slug] = convertNestedBlockPortableText(result[field.slug], field, "write");
		}
	}
	return result;
}
