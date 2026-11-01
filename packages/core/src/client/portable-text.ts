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

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		if (block._type === "block") {
			const isList = !!block.listItem;

			// Blank line between non-contiguous block types
			if (i > 0 && (!isList || !prevWasList)) {
				lines.push("");
			}

			lines.push(renderStandardBlock(block));
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

function renderStandardBlock(block: PortableTextBlock): string {
	const text = renderSpans(block.children ?? [], block.markDefs ?? []);

	// List items
	if (block.listItem) {
		const indent = "  ".repeat(Math.max(0, (block.level ?? 1) - 1));
		const marker = block.listItem === "number" ? "1." : "-";
		return `${indent}${marker} ${renderLinesAfterFirst(text)}`;
	}

	// Headings
	if (block.style && block.style.startsWith("h")) {
		const level = parseInt(block.style.substring(1), 10);
		if (level >= 1 && level <= 6) {
			return `${"#".repeat(level)} ${renderLinesAfterFirst(text)}`;
		}
	}

	// Blockquote
	if (block.style === "blockquote") {
		return `> ${renderLinesAfterFirst(text)}`;
	}

	return renderParagraph(text);
}

/**
 * markdownToPortableText reads only the first line into a list item, heading or
 * blockquote, and the lines after it as a paragraph.
 */
function renderLinesAfterFirst(text: string): string {
	const lineBreak = text.indexOf("\n");
	if (lineBreak === -1) return text;
	return text.slice(0, lineBreak + 1) + renderParagraph(text.slice(lineBreak + 1));
}

/**
 * Ends every line but the last with a backslash hard break, so markdownToPortableText
 * reads the text back as one paragraph with its line breaks. An empty line becomes a
 * line holding only the hard break; trailing empty lines cannot be written in a
 * Markdown paragraph and are dropped.
 */
function renderParagraph(text: string): string {
	const lines = text.split("\n");
	while (lines.length > 1 && lines.at(-1)?.trim() === "") lines.pop();
	return lines.map((line, index) => escapeBlockStart(line, index < lines.length - 1)).join("\\\n");
}

/**
 * Escapes the start of a line that markdownToPortableText would read as the start
 * of another block, such as `# `, `> `, `- `, `2. `, a table row or `---`. The check
 * reads the line with its hard break, because `# \` is a heading where `# ` is not.
 */
function escapeBlockStart(line: string, beforeHardBreak: boolean): string {
	const written = beforeHardBreak ? `${line}\\` : line;
	// With afterListItem set any `<number>. ` counts as a list item, so the escape
	// holds wherever the line ends up.
	if (line.trim() === "" || continuesParagraph(written, true)) return line;
	if (ORDERED_LIST_PATTERN.test(written)) return line.replace(ORDERED_LIST_NUMBER_PATTERN, "$1\\.");
	return line.replace(LEADING_WHITESPACE_PATTERN, "$1\\");
}

/**
 * Backslash-escapes the characters in span text that parseInline would read as
 * Markdown. A character is checked against its neighbours inside the span; at
 * the edge of the span the neighbour is unknown, so the character is escaped.
 */
function escapeInlineMarkdown(text: string): string {
	let escaped = "";
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (needsInlineEscape(character, text[index - 1], text[index + 1])) escaped += "\\";
		escaped += character;
	}
	return escaped;
}

function needsInlineEscape(
	character: string,
	previous: string | undefined,
	next: string | undefined,
): boolean {
	switch (character) {
		case "\\":
			return next === undefined || next === "\n" || ASCII_PUNCTUATION_PATTERN.test(next);
		case "`":
		case "[":
		case "]":
			return true;
		case "*":
			return !isWhitespace(previous) || !isWhitespace(next);
		case "_":
			return !(
				(isWordCharacter(previous) && isWordCharacter(next)) ||
				(isWhitespace(previous) && isWhitespace(next))
			);
		case "~":
			return previous === undefined || next === undefined || previous === "~" || next === "~";
		default:
			return false;
	}
}

function isWhitespace(character: string | undefined): boolean {
	return character !== undefined && WHITESPACE_PATTERN.test(character);
}

function isWordCharacter(character: string | undefined): boolean {
	return character !== undefined && WORD_CHARACTER_PATTERN.test(character);
}

const WRAPPING_MARKS = new Set(["strong", "em", "code", "strike-through", "strikethrough"]);

function renderSpans(spans: PortableTextSpan[], markDefs: MarkDef[]): string {
	// An empty span renders nothing, so it must not stand between a span and its neighbour.
	const textSpans = spans.filter((span) => span._type === "span" && (span.text ?? "") !== "");
	const isLink = (mark: string) => markDefs.some((d) => d._key === mark && d._type === "link");
	// The character next to the span in the output is a letter or digit only when
	// the neighbour renders without delimiters.
	const touchesWord = (neighbour: PortableTextSpan | undefined, edge: RegExp) =>
		neighbour !== undefined &&
		!(neighbour.marks ?? []).some((mark) => WRAPPING_MARKS.has(mark) || isLink(mark)) &&
		edge.test(neighbour.text ?? "");

	let result = "";

	for (const [index, span] of textSpans.entries()) {
		const marks = span.marks ?? [];
		let text = span.text ?? "";

		// `*x*` and `_x_` are not emphasis when whitespace follows the opening or
		// precedes the closing delimiter, so that whitespace goes outside. Split it
		// off before escaping, so a character next to a delimiter counts as an edge.
		let leading = "";
		let trailing = "";
		if (marks.includes("em")) {
			const start = text.length - text.trimStart().length;
			const end = Math.max(start, text.trimEnd().length);
			[leading, text, trailing] = [text.slice(0, start), text.slice(start, end), text.slice(end)];
		}
		if (!marks.includes("code")) text = escapeInlineMarkdown(text);

		for (const mark of marks) {
			if (text === "") break;
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
					case "em": {
						// An underscore inside a word does not open or close emphasis.
						const insideWord =
							(leading === "" &&
								touchesWord(textSpans[index - 1], WORD_CHARACTER_AT_END_PATTERN)) ||
							(trailing === "" &&
								touchesWord(textSpans[index + 1], WORD_CHARACTER_AT_START_PATTERN));
						text = insideWord ? `*${text}*` : `_${text}_`;
						break;
					}
					case "code":
						// One span per line: a line inside a code span that starts with `# ` or
						// `- ` would start a new block.
						text = text
							.split("\n")
							.map((line) => (line === "" ? "" : `\`${line}\``))
							.join("\n");
						break;
					case "strike-through":
					case "strikethrough":
						text = `~~${text}~~`;
						break;
				}
			}
		}

		result += leading + text + trailing;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Markdown -> PT
// ---------------------------------------------------------------------------

// Regex patterns for markdown parsing
const OPAQUE_FENCE_PATTERN = /^<!--ec:block (.+) -->$/;
// The text starts at a non-space: `\s+(.+)` backtracks quadratically on long runs of whitespace.
const HEADING_PATTERN = /^(#{1,6})\s+(\S.*)$/;
const UNORDERED_LIST_PATTERN = /^(\s*)[-*+]\s+(\S.*)$/;
const ORDERED_LIST_PATTERN = /^(\s*)\d+\.\s+(\S.*)$/;
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const CODE_FENCE_PATTERN = /^(```|~~~)/;
// In CommonMark only an ordered list that starts at 1 can interrupt a paragraph.
const PARAGRAPH_INTERRUPTING_ORDERED_LIST_PATTERN = /^\s*1\.\s+\S/;
// Table rows, thematic breaks and setext underlines stay one block per line.
const UNJOINABLE_LINE_PATTERN =
	/^\s*\||^ {0,3}(?:-+|=+|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/;
// An odd number of trailing backslashes ends in a backslash that is not escaped.
const BACKSLASH_HARD_BREAK_PATTERN = /(?:^|[^\\])(?:\\\\)*\\$/;
// CommonMark emphasis: `_` does not open or close inside a word, a single `*` next
// to another `*` does neither, and a `*` with whitespace on both sides is text.
// Inside `_x_` an underscore is text only between two word characters or two
// whitespace characters; any other `_` ends the scan, which keeps it linear.
const INLINE_MARKDOWN_PATTERN =
	/(\*\*(.+?)\*\*)|((?<![\p{L}\p{N}])_(?!\s)((?:[^_]|(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])|(?<=\s)_(?=\s))+?)(?<!\s)_(?![\p{L}\p{N}]))|(`(.+?)`)|(\[(.+?)\]\((.+?)\))|(~~(.+?)~~)|((?<!\*)\*([^\s*](?:(?:[^*]|(?<=\s)\*(?=\s))*?[^\s*])?)\*(?!\*))/dgsu;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const WORD_CHARACTER_AT_START_PATTERN = /^[\p{L}\p{N}]/u;
const WORD_CHARACTER_AT_END_PATTERN = /[\p{L}\p{N}]$/u;
const WHITESPACE_PATTERN = /\s/;
const ASCII_PUNCTUATION_PATTERN = /[!-/:-@[-`{-~]/;
const ORDERED_LIST_NUMBER_PATTERN = /^(\s*\d+)\./;
const LEADING_WHITESPACE_PATTERN = /^(\s*)/;
const LINE_BREAK_PATTERN = /\r?\n/;
const LEADING_SPACES_PATTERN = /^[ \t]+/;
// Stands in for an escaped character while INLINE_MARKDOWN_PATTERN runs.
const ESCAPED_CHARACTER = "\uE000";

/**
 * Convert Markdown to Portable Text blocks.
 * Opaque fences (<!--ec:block ... -->) are deserialized and spliced back in.
 */
export function markdownToPortableText(markdown: string): PortableTextBlock[] {
	const blocks: PortableTextBlock[] = [];
	const lines = markdown.split(LINE_BREAK_PATTERN);
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// Opaque fence
		const opaqueMatch = line.match(OPAQUE_FENCE_PATTERN);
		if (opaqueMatch) {
			try {
				blocks.push(JSON.parse(opaqueMatch[1]) as PortableTextBlock);
			} catch {
				blocks.push(makeBlock(line));
			}
			i++;
			continue;
		}

		// Code fence
		const fenceMatch = line.match(CODE_FENCE_PATTERN);
		if (fenceMatch) {
			const fence = fenceMatch[1];
			const lang = line.slice(3).trim();
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith(fence)) {
				codeLines.push(lines[i]);
				i++;
			}
			blocks.push({
				_type: "code",
				_key: generateKey(),
				language: lang || undefined,
				code: codeLines.join("\n"),
			});
			i++; // skip the closing fence
			continue;
		}

		// Blank line
		if (line.trim() === "") {
			i++;
			continue;
		}

		// Heading
		const headingMatch = line.match(HEADING_PATTERN);
		if (headingMatch) {
			blocks.push(makeBlock(headingMatch[2], `h${headingMatch[1].length}`));
			i++;
			continue;
		}

		// Blockquote
		if (line.startsWith("> ")) {
			blocks.push(makeBlock(line.slice(2), "blockquote"));
			i++;
			continue;
		}

		// Unordered list
		const ulMatch = line.match(UNORDERED_LIST_PATTERN);
		if (ulMatch) {
			const level = Math.floor(ulMatch[1].length / 2) + 1;
			blocks.push(makeListBlock(ulMatch[2], "bullet", level));
			i++;
			continue;
		}

		// Ordered list
		const olMatch = line.match(ORDERED_LIST_PATTERN);
		if (olMatch) {
			const level = Math.floor(olMatch[1].length / 2) + 1;
			blocks.push(makeListBlock(olMatch[2], "number", level));
			i++;
			continue;
		}

		// Image
		const imgMatch = line.match(IMAGE_PATTERN);
		if (imgMatch) {
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
		const afterListItem = blocks.at(-1)?.listItem != null && lines[i - 1]?.trim() !== "";
		const paragraph = [line];
		i++;
		if (!UNJOINABLE_LINE_PATTERN.test(line)) {
			while (i < lines.length && continuesParagraph(lines[i], afterListItem)) {
				joinParagraphLine(paragraph, lines[i]);
				i++;
			}
		}
		blocks.push(makeBlock(paragraph.join("")));
	}

	return blocks;
}

/**
 * After a list item any number starts the next item, so a wrapped item's
 * continuation line does not swallow the items that follow it.
 */
function continuesParagraph(line: string, afterListItem: boolean): boolean {
	return (
		line.trim() !== "" &&
		!OPAQUE_FENCE_PATTERN.test(line) &&
		!CODE_FENCE_PATTERN.test(line) &&
		!HEADING_PATTERN.test(line) &&
		!line.startsWith("> ") &&
		!UNORDERED_LIST_PATTERN.test(line) &&
		!(afterListItem ? ORDERED_LIST_PATTERN : PARAGRAPH_INTERRUPTING_ORDERED_LIST_PATTERN).test(
			line,
		) &&
		!IMAGE_PATTERN.test(line) &&
		!UNJOINABLE_LINE_PATTERN.test(line)
	);
}

// A loop instead of /[ \t]+$/, which is quadratic on long runs of spaces or tabs.
function trimTrailingSpaces(line: string): string {
	let end = line.length;
	while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
	return line.slice(0, end);
}

/**
 * Appends the next line to a paragraph whose last entry is the line before it.
 * In CommonMark a line ending in two spaces or a backslash is a hard break; any
 * other line break inside a paragraph is soft and reads as a space.
 */
function joinParagraphLine(paragraph: string[], next: string): void {
	const line = paragraph.pop() ?? "";
	const backslashBreak = BACKSLASH_HARD_BREAK_PATTERN.test(line);
	const hardBreak = backslashBreak || line.endsWith("  ");
	// Whitespace before a backslash break is text; before a two-space break it is the break.
	const head = backslashBreak ? line.slice(0, -1) : trimTrailingSpaces(line);
	// A line holding only the hard break also drops the space before it.
	if (head === "") paragraph.push(trimTrailingSpaces(paragraph.pop() ?? ""));
	paragraph.push(head + (hardBreak ? "\n" : " "), next.replace(LEADING_SPACES_PATTERN, ""));
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

/**
 * Parse inline markdown (bold, italic, code, links, strikethrough) into PT spans + markDefs.
 */
function parseInline(markdown: string): ParsedInline {
	const spans: PortableTextSpan[] = [];
	const markDefs: MarkDef[] = [];
	const regex = INLINE_MARKDOWN_PATTERN;
	const { masked, text } = resolveEscapes(markdown);

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(masked)) !== null) {
		const indices = match.indices;
		const group = (n: number) => {
			const range = indices?.[n];
			return range ? text.slice(range[0], range[1]) : undefined;
		};

		if (match.index > lastIndex) {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: text.slice(lastIndex, match.index),
				marks: [],
			});
		}

		if (match[2] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: group(2), marks: ["strong"] });
		} else if (match[4] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: group(4), marks: ["em"] });
		} else if (match[6] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: group(6), marks: ["code"] });
		} else if (match[8] != null && match[9] != null) {
			const key = generateKey();
			markDefs.push({ _key: key, _type: "link", href: group(9) });
			spans.push({ _type: "span", _key: generateKey(), text: group(8), marks: [key] });
		} else if (match[11] != null) {
			spans.push({
				_type: "span",
				_key: generateKey(),
				text: group(11),
				marks: ["strike-through"],
			});
		} else if (match[13] != null) {
			spans.push({ _type: "span", _key: generateKey(), text: group(13), marks: ["em"] });
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

/**
 * Resolves CommonMark backslash escapes outside code spans. `text` drops the
 * backslash; `masked` also swaps the escaped character for ESCAPED_CHARACTER, so
 * INLINE_MARKDOWN_PATTERN never reads it as a delimiter. Both have the same
 * length, so a match in `masked` slices the same characters out of `text`.
 */
function resolveEscapes(markdown: string): { masked: string; text: string } {
	let masked = "";
	let text = "";
	let index = 0;
	while (index < markdown.length) {
		const character = markdown[index];
		const next = markdown[index + 1];
		if (character === "\\" && next !== undefined && ASCII_PUNCTUATION_PATTERN.test(next)) {
			masked += ESCAPED_CHARACTER;
			text += next;
			index += 2;
			continue;
		}
		// Backslashes inside a code span are literal.
		const codeEnd = character === "`" ? markdown.indexOf("`", index + 2) : -1;
		const chunk = codeEnd === -1 ? character : markdown.slice(index, codeEnd + 1);
		masked += chunk;
		text += chunk;
		index += chunk.length;
	}
	return { masked, text };
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
