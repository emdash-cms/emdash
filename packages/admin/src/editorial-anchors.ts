/**
 * Anchors for editorial comment threads: where a thread points in an entry,
 * and how to find that place again after the content changes.
 *
 * Server-safe and dependency-free: the admin editor and EmDash core both
 * import this module.
 *
 * Text offsets count UTF-16 code units in the concatenated `text` of a
 * block's spans, the same units as JavaScript string indices.
 */

export type EditorialAnchor =
	| { type: "entry" }
	| { type: "field"; field: string }
	| { type: "block"; field: string; blockKey: string }
	| EditorialTextAnchor;

export interface EditorialTextAnchor {
	type: "text";
	field: string;
	blockKey: string;
	start: number;
	end: number;
	quote: string;
	prefix: string;
	suffix: string;
}

export type ResolvedAnchor = { state: "attached"; anchor: EditorialAnchor } | { state: "orphaned" };

export const EDITORIAL_QUOTE_MAX_LENGTH = 2_000;
export const EDITORIAL_CONTEXT_MAX_LENGTH = 64;

interface TextBlock {
	key: string;
	text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The text of a Portable Text block's spans, or `null` for any other block. */
export function blockText(block: unknown): string | null {
	if (!isRecord(block) || block._type !== "block" || !Array.isArray(block.children)) return null;
	let text = "";
	for (const child of block.children) {
		if (isRecord(child) && child._type === "span" && typeof child.text === "string") {
			text += child.text;
		}
	}
	return text;
}

function blockKeyOf(block: unknown): string | null {
	return isRecord(block) && typeof block._key === "string" ? block._key : null;
}

function textBlocks(fieldValue: unknown): TextBlock[] {
	if (!Array.isArray(fieldValue)) return [];
	const blocks: TextBlock[] = [];
	for (const block of fieldValue) {
		const key = blockKeyOf(block);
		const text = blockText(block);
		if (key !== null && text !== null) blocks.push({ key, text });
	}
	return blocks;
}

function hasBlock(fieldValue: unknown, blockKey: string): boolean {
	return Array.isArray(fieldValue) && fieldValue.some((block) => blockKeyOf(block) === blockKey);
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Up to the context limit of text before `start`, never starting mid-character. */
function prefixBefore(text: string, start: number): string {
	let from = Math.max(0, start - EDITORIAL_CONTEXT_MAX_LENGTH);
	if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from += 1;
	return text.slice(from, start);
}

/** Up to the context limit of text after `end`, never ending mid-character. */
function suffixAfter(text: string, end: number): string {
	let to = Math.min(text.length, end + EDITORIAL_CONTEXT_MAX_LENGTH);
	if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;
	return text.slice(end, to);
}

function textAnchorAt(field: string, block: TextBlock, start: number, end: number) {
	return {
		type: "text",
		field,
		blockKey: block.key,
		start,
		end,
		quote: block.text.slice(start, end),
		prefix: prefixBefore(block.text, start),
		suffix: suffixAfter(block.text, end),
	} satisfies EditorialTextAnchor;
}

/**
 * A text anchor for the range `start`–`end` of a block, with its quote and
 * surrounding context taken from the field's value. Returns `null` when the
 * block isn't a text block in the field, or the range is empty, out of bounds,
 * or longer than a quote may be.
 */
export function createTextAnchor(
	fieldValue: unknown,
	field: string,
	blockKey: string,
	start: number,
	end: number,
): EditorialTextAnchor | null {
	const block = textBlocks(fieldValue).find((candidate) => candidate.key === blockKey);
	if (!block) return null;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	if (start < 0 || end > block.text.length || start >= end) return null;
	if (end - start > EDITORIAL_QUOTE_MAX_LENGTH) return null;
	return textAnchorAt(field, block, start, end);
}

function commonSuffixLength(a: string, b: string): number {
	let length = 0;
	while (
		length < a.length &&
		length < b.length &&
		a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)
	) {
		length += 1;
	}
	return length;
}

function commonPrefixLength(a: string, b: string): number {
	let length = 0;
	while (length < a.length && length < b.length && a.charCodeAt(length) === b.charCodeAt(length)) {
		length += 1;
	}
	return length;
}

interface Candidate {
	block: TextBlock;
	start: number;
	context: number;
	distance: number;
}

function findCandidates(
	blocks: TextBlock[],
	quote: string,
	context: { prefix: string; suffix: string; start?: number },
): Candidate[] {
	const candidates: Candidate[] = [];
	for (const block of blocks) {
		let index = block.text.indexOf(quote);
		while (index !== -1) {
			const before = block.text.slice(0, index);
			const after = block.text.slice(index + quote.length);
			candidates.push({
				block,
				start: index,
				context:
					commonSuffixLength(before, context.prefix) + commonPrefixLength(after, context.suffix),
				distance: context.start === undefined ? 0 : Math.abs(index - context.start),
			});
			index = block.text.indexOf(quote, index + 1);
		}
	}
	return candidates.toSorted((a, b) => b.context - a.context || a.distance - b.distance);
}

/**
 * Finds the anchor's place in the field's current value. A text anchor is
 * looked for at its stored range, then by its quote in its own block, then by
 * its quote anywhere in the field. Matches are ranked by how much of the
 * stored context surrounds them, then by distance from the stored offset.
 *
 * Field anchors always resolve here; whether the field still exists in the
 * collection is for the caller to check.
 */
export function resolveAnchor(fieldValue: unknown, anchor: EditorialAnchor): ResolvedAnchor {
	switch (anchor.type) {
		case "entry":
		case "field":
			return { state: "attached", anchor };
		case "block":
			return hasBlock(fieldValue, anchor.blockKey)
				? { state: "attached", anchor }
				: { state: "orphaned" };
		case "text":
			return resolveTextAnchor(fieldValue, anchor);
	}
}

function resolveTextAnchor(fieldValue: unknown, anchor: EditorialTextAnchor): ResolvedAnchor {
	const blocks = textBlocks(fieldValue);
	const own = blocks.find((block) => block.key === anchor.blockKey);

	if (own && own.text.slice(anchor.start, anchor.end) === anchor.quote) {
		return { state: "attached", anchor: textAnchorAt(anchor.field, own, anchor.start, anchor.end) };
	}

	const searches = own ? [[own], blocks] : [blocks];
	for (const scope of searches) {
		const [best] = findCandidates(scope, anchor.quote, anchor);
		if (best) {
			return {
				state: "attached",
				anchor: textAnchorAt(
					anchor.field,
					best.block,
					best.start,
					best.start + anchor.quote.length,
				),
			};
		}
	}
	return { state: "orphaned" };
}

export type QuoteLookup =
	| { status: "found"; anchor: EditorialTextAnchor }
	| { status: "missing" }
	| { status: "ambiguous" };

/**
 * Finds a quote in a field without a stored position, as when an agent asks
 * to comment on "the second sentence". Context narrows the match; when the
 * best matches tie, the quote is ambiguous.
 */
export function locateQuote(
	fieldValue: unknown,
	field: string,
	quote: string,
	context: { prefix?: string; suffix?: string } = {},
): QuoteLookup {
	if (quote.length === 0 || quote.length > EDITORIAL_QUOTE_MAX_LENGTH) return { status: "missing" };
	const [best, next] = findCandidates(textBlocks(fieldValue), quote, {
		prefix: context.prefix ?? "",
		suffix: context.suffix ?? "",
	});
	if (!best) return { status: "missing" };
	if (next && next.context === best.context) return { status: "ambiguous" };
	return {
		status: "found",
		anchor: textAnchorAt(field, best.block, best.start, best.start + quote.length),
	};
}

/** Whether two anchors point at the same place with the same context. */
export function sameAnchor(a: EditorialAnchor, b: EditorialAnchor): boolean {
	if (a.type !== b.type) return false;
	switch (a.type) {
		case "entry":
			return true;
		case "field":
			return b.type === "field" && a.field === b.field;
		case "block":
			return b.type === "block" && a.field === b.field && a.blockKey === b.blockKey;
		case "text":
			return (
				b.type === "text" &&
				a.field === b.field &&
				a.blockKey === b.blockKey &&
				a.start === b.start &&
				a.end === b.end &&
				a.quote === b.quote &&
				a.prefix === b.prefix &&
				a.suffix === b.suffix
			);
	}
}

/**
 * The inline content of a ProseMirror textblock, typed structurally so this
 * module needs no ProseMirror import.
 */
export interface TextblockLike {
	content: {
		forEach(fn: (child: InlineNodeLike, offset: number) => void): void;
	};
}

export interface InlineNodeLike {
	isText: boolean;
	text?: string | null;
	nodeSize: number;
	type: { name: string };
}

/** Code units an inline node contributes to the block's Portable Text. */
function inlineTextLength(node: InlineNodeLike): number {
	if (node.isText) return node.text?.length ?? 0;
	return node.type.name === "hardBreak" ? 1 : 0;
}

/**
 * The document position of a text offset in a textblock whose content starts
 * at `contentStart` (the textblock's position plus one).
 */
export function textOffsetToPos(
	textblock: TextblockLike,
	contentStart: number,
	offset: number,
): number {
	let remaining = offset;
	let pos: number | null = null;
	let size = 0;
	textblock.content.forEach((child, childOffset) => {
		size = childOffset + child.nodeSize;
		if (pos !== null) return;
		const length = inlineTextLength(child);
		if (child.isText ? remaining <= length : remaining === 0) {
			pos = contentStart + childOffset + remaining;
			return;
		}
		remaining -= length;
	});
	return pos ?? contentStart + size;
}

/**
 * The text offset of a document position in a textblock whose content starts
 * at `contentStart`. Positions inside a non-text inline node count from its
 * start.
 */
export function posToTextOffset(
	textblock: TextblockLike,
	contentStart: number,
	pos: number,
): number {
	const target = pos - contentStart;
	let offset = 0;
	let done = false;
	textblock.content.forEach((child, childOffset) => {
		if (done) return;
		if (target <= childOffset) {
			done = true;
			return;
		}
		if (target < childOffset + child.nodeSize) {
			offset += child.isText ? target - childOffset : 0;
			done = true;
			return;
		}
		offset += inlineTextLength(child);
	});
	return offset;
}
