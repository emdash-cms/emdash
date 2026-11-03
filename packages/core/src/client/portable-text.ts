import { marked, type Token, type Tokens } from "marked";

/**
 * Portable Text <-> Markdown conversion layer.
 *
 * Three tiers of block handling:
 *   Tier 1: Standard PT blocks <-> standard Markdown (headings, paragraphs, lists, etc.)
 *   Tier 2: EmDash custom blocks <-> Markdown directives (future)
 *   Tier 3: Unknown blocks <-> opaque HTML comment fences (preserved, not editable)
 */

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

export interface PortableTextTableCell {
	_type: "tableCell";
	_key: string;
	content: PortableTextSpan[];
	markDefs?: MarkDef[];
	isHeader?: boolean;
	colspan?: number;
	rowspan?: number;
	colwidth?: number[];
	textAlign?: "left" | "center" | "right" | "justify";
	[key: string]: unknown;
}

export interface PortableTextTableRow {
	_type: "tableRow";
	_key: string;
	cells: PortableTextTableCell[];
	[key: string]: unknown;
}

export interface PortableTextTableBlock {
	_type: "table";
	_key: string;
	rows: PortableTextTableRow[];
	hasHeaderRow?: boolean;
	markDefs?: MarkDef[];
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
	const listAncestors: Array<{ level: number; listItem: string }> = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		if (block._type === "block") {
			const isList = !!block.listItem;

			// Blank line between non-contiguous block types
			if (i > 0 && (!isList || !prevWasList)) {
				lines.push("");
			}

			if (isList) {
				const level = block.level ?? 1;
				while (
					listAncestors.length > 0 &&
					listAncestors[listAncestors.length - 1].level >= level
				) {
					listAncestors.pop();
				}

				let indent = "";
				for (const ancestor of listAncestors) {
					indent += ancestor.listItem === "number" ? "   " : "  ";
				}

				const marker = block.listItem === "number" ? "1." : "-";
				const text = renderSpans(block.children ?? [], block.markDefs ?? []);
				lines.push(`${indent}${marker} ${text}`);
				listAncestors.push({ level, listItem: block.listItem! });
			} else {
				listAncestors.length = 0;
				lines.push(renderStandardBlock(block));
			}
			prevWasList = isList;
		} else if (block._type === "code") {
			listAncestors.length = 0;
			if (i > 0) lines.push("");
			const lang = (block.language as string) || "";
			const code = (block.code as string) || "";
			lines.push("```" + lang);
			lines.push(code);
			lines.push("```");
			prevWasList = false;
		} else if (block._type === "image") {
			listAncestors.length = 0;
			if (i > 0) lines.push("");
			const alt = (block.alt as string) || "";
			const url = (block.asset as { url?: string })?.url || "";
			lines.push(`![${alt}](${url})`);
			prevWasList = false;
		} else if (block._type === "table") {
			listAncestors.length = 0;
			if (canSerializeTableAsGfm(block)) {
				if (i > 0) lines.push("");
				const rows = block.rows as PortableTextTableRow[];
				const headerRow = rows[0];
				const headerTexts = headerRow.cells.map((c) =>
					renderSpans(c.content || [], resolveCellMarkDefs(block.markDefs, c.markDefs))
						.replaceAll("|", "\\|")
						.trim(),
				);
				const alignments = headerRow.cells.map((c) => {
					if (c.textAlign === "center") return ":---:";
					if (c.textAlign === "right") return "---:";
					if (c.textAlign === "left") return ":---";
					return "---";
				});
				lines.push("| " + headerTexts.join(" | ") + " |");
				lines.push("| " + alignments.join(" | ") + " |");

				for (let r = 1; r < rows.length; r++) {
					const bodyRow = rows[r];
					const bodyTexts = bodyRow.cells.map((c) =>
						renderSpans(c.content || [], resolveCellMarkDefs(block.markDefs, c.markDefs))
							.replaceAll("|", "\\|")
							.trim(),
					);
					lines.push("| " + bodyTexts.join(" | ") + " |");
				}
				prevWasList = false;
			} else {
				// Complex table or non-canonical/unsupported formatting -> preserve losslessly as opaque fence
				if (i > 0) lines.push("");
				lines.push(`<!--ec:block ${JSON.stringify(block)} -->`);
				prevWasList = false;
			}
		} else {
			listAncestors.length = 0;
			// Tier 3: Unknown block -> opaque fence
			if (i > 0) lines.push("");
			lines.push(`<!--ec:block ${JSON.stringify(block)} -->`);
			prevWasList = false;
		}
	}

	return lines.join("\n") + "\n";
}

function resolveCellMarkDefs(tableMarkDefs?: MarkDef[], cellMarkDefs?: MarkDef[]): MarkDef[] {
	const defs = new Map<string, MarkDef>();
	for (const d of tableMarkDefs ?? []) {
		if (d && d._key) defs.set(d._key, d);
	}
	for (const d of cellMarkDefs ?? []) {
		if (d && d._key) defs.set(d._key, d);
	}
	return Array.from(defs.values());
}

function canSerializeTableAsGfm(block: PortableTextBlock): boolean {
	const rows = (block.rows as PortableTextTableRow[]) || [];
	if (!Array.isArray(rows) || rows.length === 0) return false;
	if (!rows.every((r) => r && typeof r === "object" && Array.isArray(r.cells))) return false;

	const colCount = rows[0].cells.length;
	if (colCount === 0) return false;
	if (!rows.every((r) => r.cells.length === colCount)) return false;

	const row0IsHeader =
		block.hasHeaderRow === true ||
		(rows[0].cells.length > 0 && rows[0].cells.every((c) => c.isHeader === true));
	if (!row0IsHeader) return false;

	for (let r = 1; r < rows.length; r++) {
		if (rows[r].cells.some((c) => c.isHeader === true)) return false;
	}

	const colAlignments: Array<string | undefined> = rows[0].cells.map((c) => c.textAlign);

	for (let r = 0; r < rows.length; r++) {
		for (let c = 0; c < colCount; c++) {
			const cell = rows[r].cells[c];
			if (!cell) return false;

			if (cell.colspan != null && cell.colspan > 1) return false;
			if (cell.rowspan != null && cell.rowspan > 1) return false;
			if (Array.isArray(cell.colwidth) && cell.colwidth.length > 0) return false;
			if (cell.textAlign === "justify") return false;

			if (cell.content && Array.isArray(cell.content)) {
				for (const span of cell.content) {
					if (span.text && span.text.includes("\n")) return false;
				}
			}

			if (r > 0 && cell.textAlign !== undefined) {
				const expectedAlign = colAlignments[c] ?? undefined;
				if (cell.textAlign !== expectedAlign) return false;
			}
		}
	}

	return true;
}

function renderStandardBlock(block: PortableTextBlock): string {
	const text = renderSpans(block.children ?? [], block.markDefs ?? []);

	// List items
	if (block.listItem) {
		const indent = (block.listItem === "number" ? "   " : "  ").repeat(
			Math.max(0, (block.level ?? 1) - 1),
		);
		const marker = block.listItem === "number" ? "1." : "-";
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

const OPAQUE_FENCE_PATTERN = /^<!--ec:block (.+) -->$/;

function parseCodeFence(langStr: string = ""): { language?: string; filename?: string } {
	const trimmed = langStr.trim();
	if (!trimmed) return {};

	const fileMatch = trimmed.match(/(?:filename|title)=["']?([^"'\s]+)["']?/i);
	if (fileMatch) {
		const filename = fileMatch[1];
		const language =
			trimmed.split(/\s+/)[0].replace(/(?:filename|title)=.*/i, "").trim() || undefined;
		return { language, filename };
	}

	if (trimmed.includes(":")) {
		const [language, ...rest] = trimmed.split(":");
		return { language: language.trim() || undefined, filename: rest.join(":").trim() };
	}

	const parts = trimmed.split(/\s+/);
	if (parts.length > 1 && (parts[1].includes(".") || parts[1].includes("/"))) {
		return { language: parts[0], filename: parts[1] };
	}

	return { language: parts[0] || undefined };
}

function processInlineTokens(
	tokens: Token[],
	markDefs: MarkDef[],
	activeMarks: string[] = [],
): PortableTextSpan[] {
	const spans: PortableTextSpan[] = [];

	for (const token of tokens) {
		if (token.type === "text" || token.type === "escape") {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: token.text,
				marks: [...activeMarks],
			});
		} else if (token.type === "codespan") {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: token.text,
				marks: [...activeMarks, "code"],
			});
		} else if (token.type === "strong") {
			const childTokens = (token as Tokens.Strong).tokens || [];
			spans.push(...processInlineTokens(childTokens, markDefs, [...activeMarks, "strong"]));
		} else if (token.type === "em") {
			const childTokens = (token as Tokens.Em).tokens || [];
			spans.push(...processInlineTokens(childTokens, markDefs, [...activeMarks, "em"]));
		} else if (token.type === "del") {
			const childTokens = (token as Tokens.Del).tokens || [];
			spans.push(...processInlineTokens(childTokens, markDefs, [...activeMarks, "strike-through"]));
		} else if (token.type === "link") {
			const linkToken = token as Tokens.Link;
			const key = generateKey();
			markDefs.push({
				_key: key,
				_type: "link",
				href: linkToken.href,
			});
			const childTokens = linkToken.tokens || [
				{ type: "text", raw: linkToken.text, text: linkToken.text } as Token,
			];
			spans.push(...processInlineTokens(childTokens, markDefs, [...activeMarks, key]));
		} else if (token.type === "br") {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: "\n",
				marks: [...activeMarks],
			});
		} else if ("tokens" in token && Array.isArray((token as any).tokens)) {
			spans.push(...processInlineTokens((token as any).tokens, markDefs, activeMarks));
		} else if ("text" in token && typeof (token as any).text === "string") {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: (token as any).text,
				marks: [...activeMarks],
			});
		}
	}

	// Merge contiguous spans with identical marks
	const merged: PortableTextSpan[] = [];
	for (const span of spans) {
		if (!span.text) continue;
		const last = merged[merged.length - 1];
		if (
			last &&
			(last.marks ?? []).length === (span.marks ?? []).length &&
			[...(last.marks ?? [])].sort().join(",") === [...(span.marks ?? [])].sort().join(",")
		) {
			last.text = (last.text ?? "") + (span.text ?? "");
		} else {
			merged.push({ ...span });
		}
	}

	return merged.length > 0 ? merged : [{ _type: "span", _key: generateKey(), text: "", marks: [] }];
}

/**
 * Convert Markdown to Portable Text blocks.
 * Opaque fences (<!--ec:block ... -->) are deserialized and spliced back in.
 */
export function markdownToPortableText(markdown: string): PortableTextBlock[] {
	const blocks: PortableTextBlock[] = [];
	const tokens = marked.lexer(markdown);

	function processListItems(items: Tokens.ListItem[], ordered: boolean, level = 1) {
		for (const item of items) {
			const itemTokens = item.tokens || [];
			const inlineTokens: Token[] = [];
			const nestedLists: Tokens.List[] = [];

			for (const t of itemTokens) {
				if (t.type === "list") {
					nestedLists.push(t as Tokens.List);
				} else if (t.type === "text" && (t as any).tokens) {
					inlineTokens.push(...(t as any).tokens);
				} else if (t.type === "paragraph") {
					if (inlineTokens.length > 0) {
						inlineTokens.push({ type: "br", raw: "\n" } as Token);
					}
					inlineTokens.push(...(t as Tokens.Paragraph).tokens);
				} else if (t.type === "space") {
					// skip space tokens
				} else {
					inlineTokens.push(t);
				}
			}

			const markDefs: MarkDef[] = [];
			const spans = processInlineTokens(inlineTokens, markDefs);

			blocks.push({
				_type: "block",
				_key: generateKey(),
				listItem: ordered ? "number" : "bullet",
				level,
				style: "normal",
				markDefs,
				children: spans,
			});

			for (const nested of nestedLists) {
				processListItems(nested.items, !!nested.ordered, level + 1);
			}
		}
	}

	for (const token of tokens) {
		if (token.type === "space") continue;

		if (token.type === "html") {
			const raw = token.raw?.trim() || "";
			const opaqueMatch = raw.match(OPAQUE_FENCE_PATTERN);
			if (opaqueMatch) {
				try {
					blocks.push(JSON.parse(opaqueMatch[1]) as PortableTextBlock);
					continue;
				} catch {
					// Fall through to plain text if JSON invalid
				}
			}

			// Preserve unsupported HTML as plain text block so content is not lost
			if (raw) {
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: generateKey(), text: raw, marks: [] }],
				});
			}
			continue;
		}

		if (token.type === "heading") {
			const hToken = token as Tokens.Heading;
			const markDefs: MarkDef[] = [];
			const spans = processInlineTokens(
				hToken.tokens || [{ type: "text", raw: hToken.text, text: hToken.text } as Token],
				markDefs,
			);
			blocks.push({
				_type: "block",
				_key: generateKey(),
				style: `h${hToken.depth}`,
				markDefs,
				children: spans,
			});
		} else if (token.type === "paragraph") {
			const pToken = token as Tokens.Paragraph;
			const text = pToken.text?.trim() || "";
			const opaqueMatch = text.match(OPAQUE_FENCE_PATTERN);
			if (opaqueMatch) {
				try {
					blocks.push(JSON.parse(opaqueMatch[1]) as PortableTextBlock);
					continue;
				} catch {
					// Fall through
				}
			}

			const hasImage = pToken.tokens.some((t) => t.type === "image");
			if (!hasImage) {
				const markDefs: MarkDef[] = [];
				const spans = processInlineTokens(pToken.tokens, markDefs);
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "normal",
					markDefs,
					children: spans,
				});
			} else {
				// Paragraph contains one or more images: split into image and text blocks
				let currentTokens: Token[] = [];
				const flush = () => {
					if (
						currentTokens.length > 0 &&
						currentTokens[0].type === "text" &&
						typeof currentTokens[0].text === "string"
					) {
						currentTokens[0].text = currentTokens[0].text.replace(/^\n+/, "");
					}
					const nonWs = currentTokens.filter((t) => t.type !== "text" || t.text.trim() !== "");
					if (nonWs.length > 0) {
						const markDefs: MarkDef[] = [];
						const spans = processInlineTokens(currentTokens, markDefs);
						if (spans.length > 0 && spans.some((s) => (s.text ?? "").trim() !== "")) {
							blocks.push({
								_type: "block",
								_key: generateKey(),
								style: "normal",
								markDefs,
								children: spans,
							});
						}
					}
					currentTokens = [];
				};

				for (const t of pToken.tokens) {
					if (t.type === "image") {
						flush();
						const img = t as Tokens.Image;
						blocks.push({
							_type: "image",
							_key: generateKey(),
							alt: img.text || "",
							asset: { url: img.href },
						});
					} else {
						currentTokens.push(t);
					}
				}
				flush();
			}
		} else if (token.type === "code") {
			const cToken = token as Tokens.Code;
			const { language, filename } = parseCodeFence(cToken.lang);
			const codeBlock: PortableTextBlock = {
				_type: "code",
				_key: generateKey(),
				code: cToken.text,
			};
			if (language) codeBlock.language = language;
			if (filename) codeBlock.filename = filename;
			blocks.push(codeBlock);
		} else if (token.type === "table") {
			const tToken = token as Tokens.Table;
			const rows: PortableTextTableRow[] = [];

			if (tToken.header && tToken.header.length > 0) {
				const headerCells: PortableTextTableCell[] = tToken.header.map((cell, colIndex) => {
					const cellMarkDefs: MarkDef[] = [];
					const content = processInlineTokens(cell.tokens || [], cellMarkDefs);
					const tableCell: PortableTextTableCell = {
						_type: "tableCell",
						_key: generateKey(),
						isHeader: true,
						content,
					};
					if (cellMarkDefs.length > 0) tableCell.markDefs = cellMarkDefs;
					const align = tToken.align[colIndex];
					if (align === "left" || align === "center" || align === "right") {
						tableCell.textAlign = align;
					}
					return tableCell;
				});
				rows.push({
					_type: "tableRow",
					_key: generateKey(),
					cells: headerCells,
				});
			}

			for (const row of tToken.rows) {
				const bodyCells: PortableTextTableCell[] = row.map((cell, colIndex) => {
					const cellMarkDefs: MarkDef[] = [];
					const content = processInlineTokens(cell.tokens || [], cellMarkDefs);
					const tableCell: PortableTextTableCell = {
						_type: "tableCell",
						_key: generateKey(),
						content,
					};
					if (cellMarkDefs.length > 0) tableCell.markDefs = cellMarkDefs;
					const align = tToken.align[colIndex];
					if (align === "left" || align === "center" || align === "right") {
						tableCell.textAlign = align;
					}
					return tableCell;
				});
				rows.push({
					_type: "tableRow",
					_key: generateKey(),
					cells: bodyCells,
				});
			}

			blocks.push({
				_type: "table",
				_key: generateKey(),
				hasHeaderRow: !!(tToken.header && tToken.header.length > 0),
				rows,
			});
		} else if (token.type === "blockquote") {
			const bToken = token as Tokens.Blockquote;
			for (const sub of bToken.tokens) {
				if (sub.type === "paragraph") {
					const markDefs: MarkDef[] = [];
					const spans = processInlineTokens((sub as Tokens.Paragraph).tokens || [], markDefs);
					blocks.push({
						_type: "block",
						_key: generateKey(),
						style: "blockquote",
						markDefs,
						children: spans,
					});
				} else if (sub.type === "heading") {
					const markDefs: MarkDef[] = [];
					const spans = processInlineTokens(
						(sub as Tokens.Heading).tokens || [
							{ type: "text", raw: (sub as Tokens.Heading).text, text: (sub as Tokens.Heading).text } as Token,
						],
						markDefs,
					);
					blocks.push({
						_type: "block",
						_key: generateKey(),
						style: "blockquote",
						markDefs,
						children: spans,
					});
				} else if (sub.type === "text") {
					const markDefs: MarkDef[] = [];
					const inlineTokens = (sub as any).tokens || [
						{ type: "text", raw: sub.text, text: sub.text } as Token,
					];
					const spans = processInlineTokens(inlineTokens, markDefs);
					blocks.push({
						_type: "block",
						_key: generateKey(),
						style: "blockquote",
						markDefs,
						children: spans,
					});
				} else if (sub.type === "list") {
					const lToken = sub as Tokens.List;
					for (const item of lToken.items) {
						const markDefs: MarkDef[] = [];
						const inlineTokens = (item as any).tokens || [
							{ type: "text", raw: item.text, text: item.text } as Token,
						];
						const spans = processInlineTokens(inlineTokens, markDefs);
						blocks.push({
							_type: "block",
							_key: generateKey(),
							style: "blockquote",
							markDefs,
							children: spans,
						});
					}
				} else {
					const rawText = (sub as any).text ?? sub.raw.replace(/^>\s*/gm, "").trim();
					if (rawText) {
						blocks.push({
							_type: "block",
							_key: generateKey(),
							style: "blockquote",
							markDefs: [],
							children: [{ _type: "span", _key: generateKey(), text: rawText, marks: [] }],
						});
					}
				}
			}
		} else if (token.type === "list") {
			const lToken = token as Tokens.List;
			processListItems(lToken.items, !!lToken.ordered, 1);
		} else if (token.type === "hr") {
			blocks.push({
				_type: "block",
				_key: generateKey(),
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", _key: generateKey(), text: "---", marks: [] }],
			});
		}
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

/**
 * Parse inline markdown (bold, italic, code, links, strikethrough) into PT spans + markDefs.
 */
function parseInline(text: string): ParsedInline {
	const markDefs: MarkDef[] = [];
	const tokens = marked.Lexer.lexInline(text);
	const spans = processInlineTokens(tokens, markDefs);
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
