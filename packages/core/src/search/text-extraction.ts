/**
 * Text Extraction
 *
 * Extracts plain text from Portable Text blocks for FTS indexing.
 * Uses @portabletext/toolkit as base with extensions for custom block types.
 */

import { toPlainText } from "@portabletext/toolkit";

import type { PortableTextBlock } from "../content/converters/types.js";
import { isPortableTextVideoBlock } from "../content/converters/video.js";

/**
 * Validate that a value looks like a Portable Text block array.
 * Each element must have at least a `_type` string property.
 */
function isPortableTextArray(value: unknown[]): value is PortableTextBlock[] {
	return value.every(
		(item) =>
			typeof item === "object" &&
			item !== null &&
			"_type" in item &&
			typeof item._type === "string",
	);
}

/**
 * Extract additional text from custom block types that toPlainText doesn't handle
 */
function extractCustomBlockText(block: PortableTextBlock): string {
	// Code blocks - include the code content
	if (block._type === "code" && "code" in block && typeof block.code === "string") {
		return block.code;
	}

	// Image blocks - include alt text and caption
	if (block._type === "image") {
		const parts: string[] = [];
		if ("alt" in block && typeof block.alt === "string" && block.alt) {
			parts.push(block.alt);
		}
		if ("caption" in block && typeof block.caption === "string" && block.caption) {
			parts.push(block.caption);
		}
		return parts.join(" ");
	}

	if (isPortableTextVideoBlock(block)) {
		return block.caption ?? "";
	}

	return "";
}

/**
 * Extract plain text from Portable Text blocks
 *
 * Uses @portabletext/toolkit's toPlainText for standard blocks,
 * plus extracts text from custom block types (code, images with alt/caption, video captions).
 *
 * @param blocks - Array of Portable Text blocks (or a JSON string)
 * @returns Plain text content
 *
 * @example
 * ```typescript
 * const text = extractPlainText([
 *   {
 *     _type: "block",
 *     _key: "abc",
 *     children: [{ _type: "span", _key: "s1", text: "Hello World" }]
 *   }
 * ]);
 * // Returns: "Hello World"
 * ```
 */
export function extractPlainText(blocks: PortableTextBlock[] | string | null | undefined): string {
	if (!blocks) {
		return "";
	}

	// Handle JSON string input
	let parsedBlocks: PortableTextBlock[];
	if (typeof blocks === "string") {
		try {
			parsedBlocks = JSON.parse(blocks);
		} catch {
			// If it's not valid JSON, treat as plain text
			return blocks;
		}
	} else {
		parsedBlocks = blocks;
	}

	if (!Array.isArray(parsedBlocks)) {
		return "";
	}

	// Use official toPlainText for standard blocks.
	// toPlainText expects `{ _type: string; [key: string]: any }[]` but our blocks use
	// `unknown` index sigs. They're structurally compatible at runtime — spread each block
	// to satisfy the wider index signature without an unsafe cast.
	const toolkitBlocks = parsedBlocks.map((b) => {
		const obj: Record<string, unknown> & { _type: string } = { _type: b._type };
		for (const [key, val] of Object.entries(b)) {
			obj[key] = val;
		}
		return obj;
	});
	const standardText = toPlainText(toolkitBlocks);

	// Extract text from custom block types that toPlainText doesn't handle
	const customTexts = parsedBlocks.map(extractCustomBlockText).filter((text) => text.length > 0);

	// Combine both
	const allTexts = [standardText, ...customTexts].filter((t) => t.length > 0);
	return allTexts.join("\n");
}

/**
 * Collect Portable Text prose from anywhere inside a block value. Walks
 * objects and arrays recursively, skips `_`-prefixed keys, and extracts only
 * Portable Text arrays via `extractPlainText`. This is narrower than the SQL
 * path (see FTSManager.searchValueExpr), which also indexes any string under
 * a `text`, `alt`, `caption` or `code` key, so the two can see different text
 * for the same document.
 */
function collectBlockText(value: unknown, parts: string[]): void {
	if (Array.isArray(value)) {
		if (value.length > 0 && isPortableTextArray(value) && value.some(isPortableTextNode)) {
			const text = extractPlainText(value);
			if (text) parts.push(text);
			return;
		}
		for (const item of value) collectBlockText(item, parts);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, sub] of Object.entries(value)) {
			if (key.startsWith("_")) continue;
			collectBlockText(sub, parts);
		}
	}
}

/** Portable Text content nodes (as opposed to a block instance like `{ _type: "hero" }`). */
function isPortableTextNode(item: PortableTextBlock): boolean {
	return (
		item._type === "block" ||
		item._type === "image" ||
		item._type === "code" ||
		item._type === "video"
	);
}

/**
 * Extract text from a blocks field value: an array of `{ _type, ...subFields }`
 * objects. Only Portable Text sub-fields are extracted.
 */
function extractBlocksText(value: unknown): string {
	let blocks: unknown = value;
	if (typeof blocks === "string") {
		try {
			blocks = JSON.parse(blocks);
		} catch {
			return "";
		}
	}
	if (!Array.isArray(blocks)) return "";
	const parts: string[] = [];
	for (const block of blocks) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
		for (const [key, sub] of Object.entries(block)) {
			if (key.startsWith("_")) continue;
			collectBlockText(sub, parts);
		}
	}
	return parts.join("\n");
}

/**
 * Extract searchable text from a content entry
 *
 * Extracts text from specified fields, handling both plain text and Portable Text.
 *
 * A blocks field value is an array of `{ _type }` objects, which is
 * indistinguishable from Portable Text by shape alone. Pass `fieldTypes`
 * (field slug to field type) so `blocks` fields are walked sub-field by
 * sub-field; without it they are treated as Portable Text.
 *
 * @param entry - Content entry data
 * @param fields - Field names to extract text from
 * @param fieldTypes - Optional map of field slug to field type
 * @returns Object mapping field names to extracted text
 */
export function extractSearchableFields(
	entry: Record<string, unknown>,
	fields: string[],
	fieldTypes?: Readonly<Record<string, string>>,
): Record<string, string> {
	const result: Record<string, string> = {};

	for (const field of fields) {
		const value = entry[field];

		if (value === null || value === undefined) {
			result[field] = "";
			continue;
		}

		const fieldType = fieldTypes?.[field];
		if (fieldType === "blocks") {
			result[field] = extractBlocksText(value);
			continue;
		}

		if (typeof value === "string") {
			// Could be plain text or JSON Portable Text
			if (value.startsWith("[")) {
				result[field] = extractPlainText(value);
			} else {
				result[field] = value;
			}
		} else if (Array.isArray(value)) {
			// Validate the array looks like Portable Text before treating it as such
			if (isPortableTextArray(value)) {
				result[field] = extractPlainText(value);
			} else {
				result[field] = JSON.stringify(value);
			}
		} else if (typeof value === "object") {
			// Object — serialize to JSON for searchable text
			result[field] = JSON.stringify(value);
		} else if (typeof value === "number" || typeof value === "boolean") {
			result[field] = `${value}`;
		} else {
			result[field] = "";
		}
	}

	return result;
}
