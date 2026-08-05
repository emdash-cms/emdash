/**
 * Allocate stable, document-unique HTML `id`s for Portable Text headings.
 *
 * The primary id is a slug of the heading text. Existing block ids and the
 * Portable Text `_key` are kept as extra fragment targets so old anchors keep
 * resolving after renames or edits.
 */

import { slugify } from "../utils/slugify.js";

const HEADING_STYLES = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Safe HTML id: letter/underscore start, then alnum/hyphen/underscore. */
const SAFE_ID_PATTERN = /^[A-Za-z_][\w-]*$/;

export type HeadingIdAttrs = {
	/** Primary `id` on the heading element (slug of current text when available). */
	id: string;
	/**
	 * Additional fragment targets rendered as nested empty elements so existing
	 * ids and stable block keys keep working alongside the text slug.
	 */
	extraIds: string[];
};

type SpanLike = {
	_type?: string;
	text?: string;
	children?: SpanLike[];
};

type BlockLike = {
	_type?: string;
	_key?: string;
	style?: string;
	id?: string;
	children?: unknown;
};

/**
 * Collect plain text from a Portable Text block's children.
 * Works on both raw PT spans and the marks-tree nodes produced at render time.
 */
export function headingPlainText(children: unknown): string {
	if (!Array.isArray(children)) return "";
	const parts: string[] = [];
	const walk = (nodes: SpanLike[]) => {
		for (const node of nodes) {
			if (!node || typeof node !== "object") continue;
			if (typeof node.text === "string") {
				parts.push(node.text);
			}
			if (Array.isArray(node.children)) {
				walk(node.children);
			}
		}
	};
	walk(children as SpanLike[]);
	return parts.join("");
}

export function isHeadingStyle(style: string | undefined): boolean {
	return style !== undefined && HEADING_STYLES.has(style);
}

/**
 * True when `value` is safe to emit as an HTML `id` attribute without
 * encoding or injection risk.
 */
export function isSafeHtmlId(value: string): boolean {
	return value.length > 0 && value.length <= 128 && SAFE_ID_PATTERN.test(value);
}

/**
 * Allocate heading id attributes for one block.
 *
 * @param usedIds — mutable set of ids already claimed in this document.
 *   Pass the same set for every heading in one render.
 */
export function allocateHeadingId(options: {
	style: string | undefined;
	children: unknown;
	/** Portable Text block `_key` — stable across text edits when the editor preserves it. */
	blockKey?: string;
	/** Explicit id already on the node (e.g. imported WP anchor). */
	existingId?: string;
	usedIds: Set<string>;
}): HeadingIdAttrs | undefined {
	if (!isHeadingStyle(options.style)) return undefined;

	const plain = headingPlainText(options.children);
	const fromText = slugify(plain);
	const existing =
		typeof options.existingId === "string" && isSafeHtmlId(options.existingId)
			? options.existingId
			: undefined;
	const key =
		typeof options.blockKey === "string" && isSafeHtmlId(options.blockKey)
			? options.blockKey
			: undefined;

	// Prefer the human-readable text slug as the primary id.
	// `slugify` can yield digit-leading strings ("1st Post" → "1st-post");
	// those fail isSafeHtmlId, so prefix before uniqueness allocation.
	let base: string;
	if (fromText) {
		base = isSafeHtmlId(fromText) ? fromText : `h-${fromText}`;
	} else if (existing) {
		base = existing;
	} else if (key) {
		base = key;
	} else {
		base = "heading";
	}

	const id = uniqueId(base, options.usedIds);
	options.usedIds.add(id);

	const extraIds: string[] = [];
	// Keep an author/import-provided id even when the slug is primary.
	if (existing && existing !== id && !options.usedIds.has(existing)) {
		extraIds.push(existing);
		options.usedIds.add(existing);
	}
	// Stable block key so `#key` survives heading renames.
	if (key && key !== id && !options.usedIds.has(key)) {
		extraIds.push(key);
		options.usedIds.add(key);
	}

	return { id, extraIds };
}

/**
 * Shallow-copy heading blocks in a Portable Text value, stamping each with
 * `id` / `_headingExtraIds` for the Block renderer. Non-heading nodes are
 * returned by reference. Safe to call on the render path — does not mutate
 * the caller's array or block objects.
 */
export function assignHeadingIds<T>(value: T): T {
	if (!Array.isArray(value)) return value;

	const usedIds = new Set<string>();
	let changed = false;
	const next = value.map((item) => {
		if (!item || typeof item !== "object") return item;
		const block = item as BlockLike;
		if (block._type !== "block" || !isHeadingStyle(block.style)) return item;

		const attrs = allocateHeadingId({
			style: block.style,
			children: block.children,
			blockKey: block._key,
			existingId: typeof block.id === "string" ? block.id : undefined,
			usedIds,
		});
		if (!attrs) return item;

		changed = true;
		const stamped: BlockLike & { _headingExtraIds?: string[] } = {
			...block,
			id: attrs.id,
		};
		if (attrs.extraIds.length > 0) {
			stamped._headingExtraIds = attrs.extraIds;
		}
		return stamped;
	});

	return (changed ? next : value) as T;
}

function uniqueId(base: string, used: Set<string>): string {
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}-${n}`)) n += 1;
	return `${base}-${n}`;
}
