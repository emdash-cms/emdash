/**
 * Converts between the admin editor's ProseMirror JSON and Portable Text.
 *
 * Server-safe: nothing here touches the DOM, React or `crypto` when loaded.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { iframeEmbedFromAttrs, isBuiltInIframeBlock } from "../components/editor/iframe-embed.js";
import {
	PORTABLE_TEXT_BLOCK_ATTR,
	PORTABLE_TEXT_KEY_ATTR,
	PORTABLE_TEXT_SPAN_MARK,
} from "../components/editor/portableTextIdentity.js";
import { htmlBlockFields } from "../html-block.js";
import { isVideoBlock, videoBlockFields, videoNodeAttrs } from "../internal/video-block.js";
import { canonicalMediaProviderId, localMediaFileUrl } from "../lib/media-utils.js";
import {
	UnsupportedPortableTextMarksError,
	assertPortableTextMarksSupported,
	assertProseMirrorMarksSupported,
} from "../lib/portable-text-marks.js";
import {
	UnsafePortableTextTableError,
	portableTextTableToProseMirror,
	proseMirrorTableToPortableText,
	type PortableTextTableProseMirrorNode,
} from "../portable-text-table.js";

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
	listId?: string;
	listStart?: number;
	children: PortableTextSpan[];
	markDefs?: PortableTextMarkDef[];
	textAlign?: "left" | "center" | "right" | "justify";
}

interface PortableTextImageBlock {
	_type: "image";
	_key: string;
	asset: { _ref: string; url?: string; provider?: string; meta?: Record<string, unknown> };
	alt?: string;
	caption?: string;
	title?: string;
	width?: number;
	height?: number;
	/** LQIP blurhash — first-class field (legacy snapshots store it in `asset.meta`). */
	blurhash?: string;
	/** LQIP dominant color — first-class field (legacy snapshots store it in `asset.meta`). */
	dominantColor?: string;
	displayWidth?: number;
	displayHeight?: number;
	alignment?: "left" | "center" | "right" | "wide" | "full";
	/** `{ href, blank? }` from the editor, or a legacy bare string from WordPress imports */
	link?: string | { href: string; blank?: boolean };
}

interface PortableTextCodeBlock {
	_type: "code";
	_key: string;
	code: string;
	language?: string;
}

interface PortableTextHtmlBlock {
	_type: "htmlBlock";
	_key: string;
	html: string;
	css?: string;
	js?: string;
	isolated?: boolean;
}

interface PortableTextIframeBlock {
	_type: "iframe";
	_key: string;
	src: string;
	title?: string;
	width?: number;
	height?: number;
	allow?: string;
	allowFullscreen?: boolean;
}

export type PortableTextBlock =
	| PortableTextTextBlock
	| PortableTextImageBlock
	| PortableTextCodeBlock
	| PortableTextHtmlBlock
	| PortableTextIframeBlock
	| { _type: string; _key: string; [key: string]: unknown };

/** One image inside a gallery block — mirrors the Portable Text shape. */
export interface GalleryImage {
	_type: "image";
	_key: string;
	asset: {
		_type?: "reference";
		_ref: string;
		url?: string;
		/** Provider ID for external media (e.g., "cloudflare-images") */
		provider?: string;
	};
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
	focalX?: number;
	focalY?: number;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
}

type ClaimKey = (key: string | undefined, derived: string) => string;

/**
 * Hands out the keys of a set of siblings: a document's blocks, a block's spans
 * or mark definitions, or a gallery's images. The first holder of an explicit
 * key keeps it. A missing or repeated key is derived from the holder's
 * position, with a suffix if that is taken, so a document always serializes to
 * the same keys. Derived keys hold a `:`, which generated keys never do.
 */
function keyClaims(explicit: Iterable<string | undefined>): ClaimKey {
	const reserved = new Set<string>();
	for (const key of explicit) if (key) reserved.add(key);
	const claimed = new Set<string>();
	return (key, derived) => {
		if (key && !claimed.has(key)) {
			claimed.add(key);
			return key;
		}
		let claim = derived;
		for (let suffix = 1; claimed.has(claim) || reserved.has(claim); suffix++) {
			claim = `${derived}~${suffix}`;
		}
		claimed.add(claim);
		return claim;
	};
}

/** Keys for a table's unkeyed rows, cells and spans, in document order. */
function tableKeys(tableKey: string): () => string {
	let next = 0;
	return () => `${tableKey}:t${next++}`;
}

type ImageMedia = Pick<GalleryImage, "asset" | "alt" | "width" | "height">;

/**
 * Read an image's media reference, alt text, and dimensions from the reference
 * shape or the MediaValue that seeded `$media` stores instead. Keep in sync with
 * `resolveImageMedia` in core's content converters.
 */
function resolveImageMedia(image: unknown): ImageMedia {
	const record: Record<string, unknown> = isRecord(image) ? image : {};
	const asset: Record<string, unknown> = isRecord(record.asset) ? record.asset : {};
	// The media id is not a storage key, so local files need `url`.
	const storageKey = isRecord(asset.meta) ? attrStr(asset.meta.storageKey) : undefined;
	const url =
		attrStr(asset.url) ??
		attrStr(asset.src) ??
		(storageKey ? localMediaFileUrl(storageKey) : undefined);
	const provider = attrStr(asset.provider);
	const alt = attrStr(record.alt) ?? attrStr(asset.alt);
	const width = typeof record.width === "number" ? record.width : asset.width;
	const height = typeof record.height === "number" ? record.height : asset.height;
	const media: ImageMedia = {
		asset: {
			_type: "reference",
			_ref: attrStr(asset._ref) ?? attrStr(asset.id) ?? "",
			...(url ? { url } : {}),
			...(provider ? { provider } : {}),
		},
	};
	if (alt) media.alt = alt;
	if (typeof width === "number") media.width = width;
	if (typeof height === "number") media.height = height;
	return media;
}

/**
 * Normalize an untrusted gallery `images` value into well-formed entries.
 * Mirrors `sanitizeGalleryImages` in core's content/converters.
 */
function sanitizeGalleryImages(value: unknown, galleryKey?: string): GalleryImage[] {
	if (!Array.isArray(value)) return [];
	const entries = value as unknown[];
	const claimKey =
		galleryKey === undefined
			? undefined
			: keyClaims(entries.map((entry) => (isRecord(entry) ? attrStr(entry._key) : undefined)));
	const images: GalleryImage[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const asset = record.asset;
		if (typeof asset !== "object" || asset === null) continue;
		const { asset: reference, alt, width, height } = resolveImageMedia(record);
		const image: GalleryImage = {
			_type: "image",
			_key: claimKey
				? claimKey(attrStr(record._key), `${galleryKey}:i${images.length}`)
				: (attrStr(record._key) ?? ""),
			asset: reference,
		};
		if (alt) image.alt = alt;
		if (attrStr(record.caption)) image.caption = attrStr(record.caption);
		if (width !== undefined) image.width = width;
		if (height !== undefined) image.height = height;
		if (typeof record.focalX === "number") image.focalX = record.focalX;
		if (typeof record.focalY === "number") image.focalY = record.focalY;
		if (attrStr(record.blurhash)) image.blurhash = attrStr(record.blurhash);
		if (attrStr(record.dominantColor)) image.dominantColor = attrStr(record.dominantColor);
		images.push(image);
	}
	return images;
}

// Helpers for safely extracting typed values from ProseMirror attrs (Record<string, any>)
const attrStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const attrNum = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attrsWithPortableTextKey(
	attrs: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> {
	return { ...attrs, [PORTABLE_TEXT_KEY_ATTR]: key };
}

/**
 * Image links arrive either as `{ href, blank? }` (written by this editor) or as
 * a bare string (legacy WordPress/Gutenberg imports). Mirrors core's
 * `normalizeImageLink`; admin does not depend on the core package.
 */
function normalizeImageLink(raw: unknown): { href: string; blank?: boolean } | null {
	if (typeof raw === "string") {
		const href = raw.trim();
		return href ? { href } : null;
	}
	if (!isRecord(raw)) return null;
	const href = typeof raw.href === "string" ? raw.href.trim() : "";
	if (!href) return null;
	return raw.blank === true ? { href, blank: true } : { href };
}

function portableTextKeyFromAttrs(attrs: Record<string, unknown> | undefined): string | undefined {
	return attrStr(attrs?.[PORTABLE_TEXT_KEY_ATTR]);
}

function portableTextSpanKeyFromMarks(marks: unknown[] | undefined): string | undefined {
	for (const mark of marks ?? []) {
		if (!isRecord(mark) || mark.type !== PORTABLE_TEXT_SPAN_MARK || !isRecord(mark.attrs)) continue;
		const key = attrStr(mark.attrs.key);
		if (key) return key;
	}
	return undefined;
}

function portableTextMarkDefsFromMarks(marks: unknown[] | undefined): PortableTextMarkDef[] {
	const identity = (marks ?? []).find(
		(mark) => isRecord(mark) && mark.type === PORTABLE_TEXT_SPAN_MARK && isRecord(mark.attrs),
	);
	if (!isRecord(identity) || !isRecord(identity.attrs) || !Array.isArray(identity.attrs.markDefs)) {
		return [];
	}
	return identity.attrs.markDefs.filter(
		(markDef): markDef is PortableTextMarkDef =>
			isRecord(markDef) && typeof markDef._type === "string" && typeof markDef._key === "string",
	);
}

function portableTextBlockFromAttrs(
	attrs: Record<string, unknown> | undefined,
): PortableTextBlock | undefined {
	const block = attrs?.[PORTABLE_TEXT_BLOCK_ATTR];
	if (!isRecord(block) || typeof block._type !== "string" || typeof block._key !== "string") {
		return undefined;
	}
	return block as PortableTextBlock;
}

function customBlockData(block: PortableTextBlock): Record<string, unknown> {
	const {
		_type: _blockType,
		_key: _blockKey,
		id: _id,
		url: _url,
		...rest
	} = block as Record<string, unknown>;
	return Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith("_")));
}

function customBlockIdentity(block: PortableTextBlock): string {
	const record = block as Record<string, unknown>;
	return attrStr(record.id) ?? attrStr(record.url) ?? "";
}

function customBlockIdentityField(block: PortableTextBlock): "id" | "url" | undefined {
	if (Object.hasOwn(block, "id")) return "id";
	if (Object.hasOwn(block, "url")) return "url";
	return undefined;
}

/**
 * TrailingNode adds an empty paragraph after a final block on the first
 * transaction. It isn't content: `prosemirrorToPortableText` drops it too.
 */
export function withoutTrailingEmptyParagraph(doc: ProseMirrorNode): ProseMirrorNode {
	const last = doc.lastChild;
	if (
		doc.childCount > 1 &&
		last?.type.name === "paragraph" &&
		last.childCount === 0 &&
		portableTextKeyFromAttrs(last.attrs) === undefined
	) {
		return doc.copy(doc.content.cut(0, doc.content.size - last.nodeSize));
	}
	return doc;
}

/** The blocks of a converted document, without the empty paragraph it ends with after a final block. */
export function withoutTrailingParagraph(doc: { content: unknown[] }): unknown[] {
	const last = doc.content.at(-1) as PortableTextProseMirrorNode | undefined;
	return doc.content.length > 1 && last && isUnkeyedEmptyParagraph(last)
		? doc.content.slice(0, -1)
		: doc.content;
}

export function equalJsonValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => equalJsonValues(value, right[index]))
		);
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
	const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => Object.hasOwn(right, key) && equalJsonValues(left[key], right[key]))
	);
}

const MAX_ORDERED_LIST_START = 2_147_483_647;

type OrderedListMetadata = { listId: string; listStart: number };
type PortableTextProseMirrorNode = {
	type: string;
	attrs?: Record<string, unknown>;
	content?: PortableTextProseMirrorNode[];
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
	text?: string;
};

function normalizeListId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

function normalizeListStart(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= MAX_ORDERED_LIST_START
		? value
		: undefined;
}

function deriveLegacyListId(seed: string): string {
	const readable = `legacy:${seed}`;
	if (readable.length <= 128) return readable;
	let hash = 2_166_136_261;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16_777_619);
	}
	return `legacy:${seed.slice(0, 96)}:${(hash >>> 0).toString(36)}:${seed.length.toString(36)}`;
}

function readOrderedListMetadata(
	attrs: Record<string, unknown> | undefined,
	fallbackId: string,
): OrderedListMetadata {
	return {
		listId: normalizeListId(attrs?.listId) ?? deriveLegacyListId(fallbackId),
		listStart: normalizeListStart(attrs?.listStart) ?? normalizeListStart(attrs?.start) ?? 1,
	};
}

function clonePortableTextProseMirrorNode(
	node: PortableTextProseMirrorNode,
): PortableTextProseMirrorNode {
	return {
		...node,
		attrs: node.attrs ? { ...node.attrs } : undefined,
		content: node.content?.map(clonePortableTextProseMirrorNode),
		marks: node.marks?.map((mark) => ({
			...mark,
			attrs: mark.attrs ? { ...mark.attrs } : undefined,
		})),
	};
}

function normalizeOrderedListJson(doc: { type: "doc"; content: PortableTextProseMirrorNode[] }): {
	type: "doc";
	content: PortableTextProseMirrorNode[];
} {
	type Descriptor = {
		node: PortableTextProseMirrorNode;
		path: string;
		depth: number;
		context: string;
	};
	const normalized = {
		...doc,
		content: doc.content.map(clonePortableTextProseMirrorNode),
	};
	const lists: Descriptor[] = [];
	const visit = (
		node: PortableTextProseMirrorNode,
		path: string,
		depth: number,
		context: string,
	) => {
		if (node.type === "orderedList") lists.push({ node, path, depth, context });
		for (const [index, child] of (node.content ?? []).entries()) {
			const childPath = `${path}:${index}`;
			visit(
				child,
				childPath,
				depth + 1,
				child.type === "listItem" ? `listItem:${childPath}` : context,
			);
		}
	};
	for (const [index, node] of normalized.content.entries()) {
		visit(node, `root:${index}`, 0, "root");
	}

	const canonicalBySourceScope = new Map<string, string>();
	const assignedIds = new Set<string>();
	const descriptors = lists.map((list) => {
		const sourceId =
			normalizeListId(list.node.attrs?.listId) ??
			deriveLegacyListId(`pm-json:${list.path}:${list.depth}:${list.context}`);
		const scope = JSON.stringify([list.depth, list.context]);
		const sourceScope = JSON.stringify([sourceId, scope]);
		let listId = canonicalBySourceScope.get(sourceScope);
		if (!listId) {
			if (!assignedIds.has(sourceId)) {
				listId = sourceId;
			} else {
				let attempt = 0;
				do {
					const suffix = `:${attempt.toString(36)}`;
					const base = deriveLegacyListId(`repair:${sourceId}:${scope}`);
					listId = `${base.slice(0, 128 - suffix.length)}${suffix}`;
					attempt++;
				} while (assignedIds.has(listId));
			}
			canonicalBySourceScope.set(sourceScope, listId);
			assignedIds.add(listId);
		}
		return {
			...list,
			listId,
			scopeKey: JSON.stringify([listId, list.depth, list.context]),
		};
	});

	const bases = new Map<string, number>();
	for (const list of descriptors) {
		const listStart = normalizeListStart(list.node.attrs?.listStart);
		if (listStart !== undefined && !bases.has(list.scopeKey)) {
			bases.set(list.scopeKey, listStart);
		}
	}
	for (const list of descriptors) {
		if (!bases.has(list.scopeKey)) {
			bases.set(list.scopeKey, normalizeListStart(list.node.attrs?.start) ?? 1);
		}
	}

	const counts = new Map<string, number>();
	for (const list of descriptors) {
		const listStart = bases.get(list.scopeKey)!;
		const count = counts.get(list.scopeKey) ?? 0;
		const start = normalizeListStart(listStart + count) ?? 1;
		const directItemCount =
			list.node.content?.filter((node) => node.type === "listItem").length ?? 0;
		counts.set(list.scopeKey, count + directItemCount);
		list.node.attrs = { ...list.node.attrs, listId: list.listId, listStart, start };
	}
	return normalized;
}

// ProseMirror to Portable Text converter
export function prosemirrorToPortableText(doc: {
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
	assertProseMirrorMarksSupported(doc);

	const blocks: PortableTextBlock[] = [];
	const claimKey = keyClaims(explicitBlockKeys(doc.content));

	for (let i = 0; i < doc.content.length; i++) {
		const node = doc.content[i]!;
		if (i === doc.content.length - 1 && isUnkeyedEmptyParagraph(node)) continue;
		const converted = convertPMNode(node, `root:${i}`, claimKey);
		if (converted) blocks.push(...(Array.isArray(converted) ? converted : [converted]));
	}

	return blocks;
}

const BLOCK_CONTAINERS = new Set(["blockquote", "bulletList", "orderedList", "listItem"]);

/** Every key the document's nodes hold for their blocks, so no derived key takes one. */
function explicitBlockKeys(nodes: unknown[]): string[] {
	const keys: string[] = [];
	const visit = (node: PortableTextProseMirrorNode) => {
		const key = portableTextKeyFromAttrs(node.attrs);
		if (key) keys.push(key);
		if (node.type === "table") {
			const tableKey = attrStr(node.attrs?.emdashKey);
			if (tableKey) keys.push(tableKey);
		} else if (node.type === "pluginBlock") {
			const original = portableTextBlockFromAttrs(node.attrs);
			if (original) keys.push(original._key);
		} else if (BLOCK_CONTAINERS.has(node.type)) {
			for (const child of node.content ?? []) visit(child);
		}
	};
	for (const node of nodes as PortableTextProseMirrorNode[]) visit(node);
	return keys;
}

function isUnkeyedEmptyParagraph(node: {
	type: string;
	attrs?: Record<string, unknown>;
	content?: unknown[];
}): boolean {
	return (
		node.type === "paragraph" &&
		(node.content?.length ?? 0) === 0 &&
		portableTextKeyFromAttrs(node.attrs) === undefined
	);
}

/** A table with no cells, which merges can leave behind, holds nothing to save. */
function isEmptyTable(node: { content?: unknown[] }): boolean {
	return (node.content ?? []).every(
		(row) =>
			isRecord(row) &&
			row.type === "tableRow" &&
			(Array.isArray(row.content) ? row.content.length === 0 : row.content === undefined),
	);
}

function convertPMNode(
	node: {
		type: string;
		attrs?: Record<string, unknown>;
		content?: unknown[];
		marks?: unknown[];
		text?: string;
	},
	path: string,
	claimKey: ClaimKey,
): PortableTextBlock | PortableTextBlock[] | null {
	switch (node.type) {
		case "paragraph": {
			const key = claimKey(portableTextKeyFromAttrs(node.attrs), path);
			const { children, markDefs } = convertInlineContent(node.content || [], key);
			if (children.length === 0) return null;
			const ta = node.attrs?.textAlign;
			const textAlign = ta === "center" || ta === "right" || ta === "justify" ? ta : undefined;
			return {
				_type: "block",
				_key: key,
				style: "normal",
				children,
				...(markDefs.length > 0 ? { markDefs } : {}),
				...(textAlign ? { textAlign } : {}),
			};
		}

		case "heading": {
			const key = claimKey(portableTextKeyFromAttrs(node.attrs), path);
			const { children, markDefs } = convertInlineContent(node.content || [], key);
			const rawLevel = node.attrs?.level;
			const level = typeof rawLevel === "number" ? rawLevel : 1;
			if (children.length === 0) return null;
			const headingStyle =
				level >= 1 && level <= 6
					? (`h${level}` as PortableTextTextBlock["style"])
					: ("h1" as PortableTextTextBlock["style"]);
			const ta = node.attrs?.textAlign;
			const textAlign = ta === "center" || ta === "right" || ta === "justify" ? ta : undefined;
			return {
				_type: "block",
				_key: key,
				style: headingStyle,
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
				...(textAlign ? { textAlign } : {}),
			};
		}

		case "bulletList":
			return convertList(node.content || [], "bullet", 1, node.attrs, path, claimKey);

		case "orderedList":
			return convertList(node.content || [], "number", 1, node.attrs, path, claimKey);

		case "blockquote": {
			const blocks: PortableTextTextBlock[] = [];
			const blockquoteContent = (node.content || []) as Array<{
				type: string;
				attrs?: Record<string, unknown>;
				content?: unknown[];
			}>;
			for (const [index, child] of blockquoteContent.entries()) {
				if (child.type === "paragraph") {
					const key = claimKey(
						portableTextKeyFromAttrs(child.attrs),
						index === 0 ? path : `${path}:${index}`,
					);
					const { children, markDefs } = convertInlineContent(child.content || [], key);
					if (children.length > 0) {
						blocks.push({
							_type: "block",
							_key: key,
							style: "blockquote",
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
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
				_key: claimKey(portableTextKeyFromAttrs(node.attrs), path),
				code,
				language: typeof rawLanguage === "string" ? rawLanguage : undefined,
			};
		}

		case "htmlBlock":
			return {
				_type: "htmlBlock",
				_key: claimKey(portableTextKeyFromAttrs(node.attrs), path),
				...htmlBlockFields(node.attrs ?? {}),
			};

		case "iframeBlock":
			return {
				_type: "iframe",
				_key: claimKey(portableTextKeyFromAttrs(node.attrs), path),
				...iframeEmbedFromAttrs(node.attrs ?? {}),
			};

		case "videoBlock":
			return {
				_type: "video",
				_key: claimKey(portableTextKeyFromAttrs(node.attrs), path),
				...videoBlockFields(node.attrs ?? {}),
			};

		case "image": {
			const attrs = node.attrs ?? {};
			const provider = attrStr(attrs.provider);
			const blurhash = attrStr(attrs.blurhash);
			const dominantColor = attrStr(attrs.dominantColor);
			const title = attrStr(attrs.title);
			const caption = Object.hasOwn(attrs, "caption")
				? (attrStr(attrs.caption) ?? (title ? "" : undefined))
				: title;
			// Persist LQIP as first-class block fields, matching the image-field
			// path (MediaValue.blurhash/dominantColor) so read sites and normalize
			// don't need a `asset.meta` dual-shape. `asset.meta` is left to carry
			// only provider-specific data (we don't reconstruct it here, so any
			// non-LQIP meta keys are never silently dropped on editor round-trip).
			// Normalise link: drop when href is missing/empty so half-populated
			// { blank: true } objects don't leak into Portable Text.
			let link: { href: string; blank?: boolean } | undefined;
			const rawLink = attrs.link;
			if (rawLink && typeof rawLink === "object") {
				const linkObj = rawLink as { href?: unknown; blank?: unknown };
				const href = typeof linkObj.href === "string" ? linkObj.href.trim() : "";
				if (href) {
					link = { href };
					if (linkObj.blank === true) link.blank = true;
				}
			}
			return {
				_type: "image",
				_key: claimKey(portableTextKeyFromAttrs(node.attrs), path),
				asset: {
					_ref: attrStr(attrs.mediaId) ?? "",
					url: attrStr(attrs.src) ?? "",
					provider: provider && provider !== "local" ? provider : undefined,
				},
				alt: attrStr(attrs.alt),
				caption,
				title,
				width: attrNum(attrs.width),
				height: attrNum(attrs.height),
				...(blurhash ? { blurhash } : {}),
				...(dominantColor ? { dominantColor } : {}),
				displayWidth: attrNum(attrs.displayWidth),
				displayHeight: attrNum(attrs.displayHeight),
				alignment: attrStr(attrs.alignment) as PortableTextImageBlock["alignment"],
				link,
			};
		}

		case "horizontalRule":
			return {
				_type: "break",
				_key: claimKey(portableTextKeyFromAttrs(node.attrs), path),
				style: "lineBreak",
			};

		case "gallery": {
			const columns = node.attrs?.columns;
			const key = claimKey(portableTextKeyFromAttrs(node.attrs), path);
			return {
				_type: "gallery",
				_key: key,
				images: sanitizeGalleryImages(node.attrs?.images, key),
				...(typeof columns === "number" ? { columns } : {}),
			};
		}

		case "table": {
			if (isEmptyTable(node)) return null;
			const key = claimKey(attrStr(node.attrs?.emdashKey), path);
			const createKey = tableKeys(key);
			const table = { ...node, attrs: { ...node.attrs, emdashKey: key } };
			const result = proseMirrorTableToPortableText(table, {
				path,
				createKey,
				inlineToSpans: (content) => {
					const { children, markDefs } = convertInlineContent(content, createKey(), true);
					return {
						content: children,
						markDefs: markDefs.length > 0 ? markDefs : undefined,
					};
				},
			});
			if (!result.ok) {
				throw new UnsafePortableTextTableError(result.reason, result.raw, result.renderFallback);
			}
			return result.table;
		}

		case "pluginBlock": {
			const attrs = node.attrs ?? {};
			const blockType = typeof attrs.blockType === "string" ? attrs.blockType : "embed";
			const pluginId = typeof attrs.id === "string" ? attrs.id : "";
			const data = isRecord(attrs.data) ? attrs.data : {};
			const originalBlock = portableTextBlockFromAttrs(attrs);
			const blockKey = claimKey(portableTextKeyFromAttrs(attrs) ?? originalBlock?._key, path);

			if (
				originalBlock &&
				originalBlock._type === blockType &&
				customBlockIdentity(originalBlock) === pluginId &&
				equalJsonValues(customBlockData(originalBlock), data)
			) {
				return { ...originalBlock, _key: blockKey };
			}

			const result: Record<string, unknown> = {
				...(originalBlock
					? Object.fromEntries(
							Object.entries(originalBlock).filter(
								([key]) => key.startsWith("_") && key !== "_type" && key !== "_key",
							),
						)
					: {}),
				...data,
				_type: blockType,
				_key: blockKey,
			};
			const identityField =
				(originalBlock ? customBlockIdentityField(originalBlock) : undefined) ??
				(pluginId ? "id" : undefined);
			if (identityField) result[identityField] = pluginId;
			return result as PortableTextBlock;
		}

		default:
			return null;
	}
}

function convertList(
	items: unknown[],
	listItem: "bullet" | "number",
	level: number,
	attrs: Record<string, unknown> | undefined,
	path: string,
	claimKey: ClaimKey,
): PortableTextTextBlock[] {
	const blocks: PortableTextTextBlock[] = [];
	const typedItems = items as Array<{ type: string; content?: unknown[] }>;
	const metadata = listItem === "number" ? readOrderedListMetadata(attrs, path) : undefined;

	for (let itemIndex = 0; itemIndex < typedItems.length; itemIndex++) {
		const item = typedItems[itemIndex]!;
		if (item.type === "listItem") {
			const listItemContent = (item.content || []) as Array<{
				type: string;
				attrs?: Record<string, unknown>;
				content?: unknown[];
			}>;
			for (let childIndex = 0; childIndex < listItemContent.length; childIndex++) {
				const child = listItemContent[childIndex]!;
				if (child.type === "paragraph") {
					const key = claimKey(
						portableTextKeyFromAttrs(child.attrs),
						`${path}:${itemIndex}:${childIndex}`,
					);
					const { children, markDefs } = convertInlineContent(child.content || [], key);
					if (children.length > 0) {
						blocks.push({
							_type: "block",
							_key: key,
							style: "normal",
							listItem,
							level,
							...metadata,
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
					}
				} else if (child.type === "bulletList") {
					blocks.push(
						...convertList(
							child.content || [],
							"bullet",
							level + 1,
							child.attrs,
							`${path}:${itemIndex}:${childIndex}`,
							claimKey,
						),
					);
				} else if (child.type === "orderedList") {
					blocks.push(
						...convertList(
							child.content || [],
							"number",
							level + 1,
							child.attrs,
							`${path}:${itemIndex}:${childIndex}`,
							claimKey,
						),
					);
				}
			}
		}
	}

	return blocks;
}

/** `blockKey`: the key the block's derived span and mark definition keys start from. */
function convertInlineContent(
	nodes: unknown[],
	blockKey: string,
	preserveHardBreakBoundary = false,
): {
	children: PortableTextSpan[];
	markDefs: PortableTextMarkDef[];
} {
	const children: PortableTextSpan[] = [];
	const markDefs: PortableTextMarkDef[] = [];
	const markDefMap = new Map<string, string>();

	const typedNodes = nodes as Array<{
		type: string;
		attrs?: Record<string, unknown>;
		text?: string;
		marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
	}>;
	const spanKeys = keyClaims(
		typedNodes.map(
			(node) => portableTextKeyFromAttrs(node.attrs) ?? portableTextSpanKeyFromMarks(node.marks),
		),
	);
	const markDefKeys = keyClaims(
		typedNodes.flatMap((node) =>
			portableTextMarkDefsFromMarks(node.marks).map((markDef) => markDef._key),
		),
	);
	const claimSpanKey = (preferred?: string) =>
		spanKeys(preferred, `${blockKey}:s${children.length}`);
	const claimMarkDefKey = (preferred: string | undefined) =>
		markDefKeys(preferred, `${blockKey}:m${markDefs.length}`);

	// A line break carries its span's key but no marks, so a span it opens takes
	// the marks of the span's text that follows.
	let openedByBreak: PortableTextSpan | undefined;

	for (const node of typedNodes) {
		if (node.type === "text" && node.text) {
			const marks: string[] = [];
			const originalMarkDefs = portableTextMarkDefsFromMarks(node.marks);
			// Concurrent edits can leave both on one span, though each excludes the other.
			const subscripted = node.marks?.some((mark) => mark.type === "subscript");

			for (const mark of node.marks || []) {
				if (subscripted && mark.type === "superscript") continue;
				const markType = convertMark(mark, markDefs, markDefMap, originalMarkDefs, claimMarkDefKey);
				if (markType) {
					marks.push(markType);
				}
			}

			const preferredKey = portableTextSpanKeyFromMarks(node.marks);
			const normalizedMarks = marks.length > 0 ? marks : undefined;
			const previous = children.at(-1);
			if (
				preferredKey &&
				previous?._key === preferredKey &&
				(previous === openedByBreak || equalJsonValues(previous.marks, normalizedMarks))
			) {
				previous.text += node.text;
				previous.marks = normalizedMarks;
				openedByBreak = undefined;
				continue;
			}

			children.push({
				_type: "span",
				_key: claimSpanKey(preferredKey),
				text: node.text,
				marks: normalizedMarks,
			});
		} else if (node.type === "hardBreak") {
			const key = portableTextKeyFromAttrs(node.attrs);
			const last = children.at(-1);
			if (last && (key ? last._key === key : !preserveHardBreakBoundary)) {
				last.text += "\n";
			} else {
				const span: PortableTextSpan = {
					_type: "span",
					_key: claimSpanKey(key ?? portableTextSpanKeyFromMarks(node.marks)),
					text: "\n",
				};
				children.push(span);
				if (key) openedByBreak = span;
			}
		}
	}

	if (children.length === 0) {
		children.push({
			_type: "span",
			_key: claimSpanKey(),
			text: "",
		});
	}

	return { children, markDefs };
}

function convertMark(
	mark: { type: string; attrs?: Record<string, unknown> },
	markDefs: PortableTextMarkDef[],
	markDefMap: Map<string, string>,
	originalMarkDefs: PortableTextMarkDef[],
	claimMarkDefKey: (preferred: string | undefined) => string,
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
		case "subscript":
			return "subscript";
		case "superscript":
			return "superscript";
		case "code":
			return "code";
		case PORTABLE_TEXT_SPAN_MARK:
			return null;
		case "link": {
			const rawHref = mark.attrs?.href;
			const href = typeof rawHref === "string" ? rawHref : "";
			const blank = mark.attrs?.target === "_blank";
			const originalMarkDef = originalMarkDefs.find((markDef) => markDef._type === "link");
			// Two links can hold one definition's key, after a join or when one of them is edited.
			const mapKey = JSON.stringify([originalMarkDef?._key ?? null, href, blank]);
			if (markDefMap.has(mapKey)) {
				return markDefMap.get(mapKey)!;
			}
			const key = claimMarkDefKey(originalMarkDef?._key || undefined);
			markDefs.push({
				...originalMarkDef,
				_type: "link",
				_key: key,
				href,
				...(originalMarkDef
					? blank || Object.hasOwn(originalMarkDef, "blank")
						? { blank }
						: {}
					: { blank }),
			});
			markDefMap.set(mapKey, key);
			return key;
		}
		default:
			throw new UnsupportedPortableTextMarksError([mark.type]);
	}
}

// Type guards for PortableText block variants
function isTextBlock(block: PortableTextBlock): block is PortableTextTextBlock {
	return block._type === "block";
}

function isQuoteBlock(block: PortableTextBlock): block is PortableTextTextBlock {
	return isTextBlock(block) && !block.listItem && block.style === "blockquote";
}

/** A built-in `iframe` block. Any other belongs to a plugin and stays a plugin block. */
function isIframeBlock(block: PortableTextBlock): block is PortableTextIframeBlock {
	return block._type === "iframe" && isBuiltInIframeBlock(block);
}

function isImageBlock(block: PortableTextBlock): block is PortableTextImageBlock {
	const asset = "asset" in block ? block.asset : undefined;
	return block._type === "image" && typeof asset === "object" && asset !== null;
}

function isCodeBlock(block: PortableTextBlock): block is PortableTextCodeBlock {
	return block._type === "code";
}

// Portable Text to ProseMirror converter
/** `pluginTypes`: block types plugins register, which stay plugin blocks. */
export function portableTextToProsemirror(
	blocks: PortableTextBlock[],
	pluginTypes: ReadonlySet<string> = new Set(),
): {
	type: "doc";
	content: unknown[];
} {
	if (!blocks || blocks.length === 0) {
		return {
			type: "doc",
			content: [{ type: "paragraph" }],
		};
	}
	assertPortableTextMarksSupported(blocks);

	const content: unknown[] = [];
	let i = 0;

	while (i < blocks.length) {
		const block = blocks[i]!;

		if (isTextBlock(block) && block.listItem) {
			const listBlocks: PortableTextTextBlock[] = [];
			const listType = block.listItem;
			const runStart = i;
			const rootId = listType === "number" ? normalizeListId(block.listId) : undefined;

			// A list "run" is a level=1 anchor block plus everything that nests
			// under it (level > 1) or repeats it at the same root level/type.
			// A level=1 block with a different listItem ends the run.
			while (i < blocks.length) {
				const current = blocks[i]!;
				if (!isTextBlock(current) || !current.listItem) break;
				const level = current.level || 1;
				const currentId =
					current.listItem === "number" ? normalizeListId(current.listId) : undefined;
				const sameRootIdentity =
					listType !== "number" ||
					level > 1 ||
					(rootId ? currentId === rootId : currentId === undefined);
				if (level > 1 || (current.listItem === listType && sameRootIdentity)) {
					listBlocks.push(current);
					i++;
				} else {
					break;
				}
			}

			content.push(convertPTList(listBlocks, listType, `root:${runStart}`));
		} else if (isQuoteBlock(block)) {
			// Portable Text stores each paragraph of a quote as its own block.
			const quoteBlocks: PortableTextTextBlock[] = [];
			while (i < blocks.length && isQuoteBlock(blocks[i]!)) {
				quoteBlocks.push(blocks[i] as PortableTextTextBlock);
				i++;
			}
			content.push(convertPTQuote(quoteBlocks));
		} else {
			const converted = convertPTBlock(block, `root:${i}`, pluginTypes);
			if (converted) {
				content.push(converted);
			}
			i++;
		}
	}

	// The editor keeps an empty paragraph after a final block, and a document
	// loads in the shape the editor's normalizers give it.
	if ((content.at(-1) as PortableTextProseMirrorNode | undefined)?.type !== "paragraph") {
		content.push({ type: "paragraph" });
	}
	return normalizeOrderedListJson({
		type: "doc",
		content: content as PortableTextProseMirrorNode[],
	});
}

function getListMetadata(
	item: PortableTextTextBlock,
	fallbackSeed: string,
): { listId: string; listStart?: number } {
	const listId = normalizeListId(item.listId) ?? deriveLegacyListId(fallbackSeed);
	const listStart = normalizeListStart(item.listStart);
	return {
		listId,
		...(listStart === undefined ? {} : { listStart }),
	};
}

function belongsToNestedGroup(
	item: PortableTextTextBlock,
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

function convertPTBlock(
	block: PortableTextBlock,
	path: string,
	pluginTypes: ReadonlySet<string>,
): unknown {
	switch (block._type) {
		case "block": {
			if (!isTextBlock(block)) return null;
			const { style = "normal", children, markDefs = [], textAlign } = block;
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
						attrs: attrsWithPortableTextKey(
							{ level, ...(textAlign ? { textAlign } : {}) },
							block._key,
						),
						content: pmContent.length > 0 ? pmContent : undefined,
					};
				}
				case "blockquote":
					return convertPTQuote([block]);
				default:
					return {
						type: "paragraph",
						attrs: attrsWithPortableTextKey(textAlign ? { textAlign } : undefined, block._key),
						content: pmContent.length > 0 ? pmContent : undefined,
					};
			}
		}

		case "image": {
			if (!isImageBlock(block)) {
				const malformed = block as unknown as Record<string, unknown>;
				const title = typeof malformed.title === "string" ? malformed.title : "";
				return {
					type: "image",
					attrs: {
						src: typeof malformed.url === "string" ? malformed.url : "",
						alt: typeof malformed.alt === "string" ? malformed.alt : "",
						title,
						caption: Object.hasOwn(malformed, "caption")
							? typeof malformed.caption === "string"
								? malformed.caption
								: ""
							: title,
					},
				};
			}
			const imageBlock = block;
			const meta = imageBlock.asset.meta;
			const { asset, alt, width, height } = resolveImageMedia(imageBlock);
			// Prefer first-class LQIP fields; fall back to `asset.meta` for legacy
			// snapshots persisted before LQIP was promoted out of the provider meta bag.
			const blurhash =
				typeof imageBlock.blurhash === "string"
					? imageBlock.blurhash
					: typeof meta?.blurhash === "string"
						? meta.blurhash
						: null;
			const dominantColor =
				typeof imageBlock.dominantColor === "string"
					? imageBlock.dominantColor
					: typeof meta?.dominantColor === "string"
						? meta.dominantColor
						: null;
			return {
				type: "image",
				attrs: attrsWithPortableTextKey(
					{
						src: asset.url || `/_emdash/api/media/file/${asset._ref}`,
						alt: alt || "",
						title: imageBlock.title || "",
						caption: Object.hasOwn(imageBlock, "caption")
							? imageBlock.caption || ""
							: imageBlock.title || "",
						mediaId: asset._ref,
						provider: canonicalMediaProviderId(asset.provider),
						width,
						height,
						blurhash,
						dominantColor,
						displayWidth: imageBlock.displayWidth,
						displayHeight: imageBlock.displayHeight,
						alignment: imageBlock.alignment,
						link: normalizeImageLink(imageBlock.link),
					},
					block._key,
				),
			};
		}

		case "code": {
			if (!isCodeBlock(block)) return null;
			const codeBlock = block;
			const language =
				typeof codeBlock.language === "string" && codeBlock.language.length > 0
					? codeBlock.language
					: null;
			return {
				type: "codeBlock",
				attrs: attrsWithPortableTextKey({ language }, block._key),
				content: codeBlock.code ? [{ type: "text", text: codeBlock.code }] : undefined,
			};
		}

		case "break":
			return {
				type: "horizontalRule",
				attrs: attrsWithPortableTextKey(undefined, block._key),
			};

		case "gallery": {
			const galleryBlock = block as { _type: "gallery"; _key: string; [key: string]: unknown };
			if (!Array.isArray(galleryBlock.images)) {
				return convertCustomBlock(block);
			}
			return {
				type: "gallery",
				attrs: attrsWithPortableTextKey(
					{
						images: sanitizeGalleryImages(galleryBlock.images),
						columns: typeof galleryBlock.columns === "number" ? galleryBlock.columns : undefined,
					},
					galleryBlock._key,
				),
			};
		}

		case "htmlBlock":
			return {
				type: "htmlBlock",
				attrs: attrsWithPortableTextKey({ ...htmlBlockFields(block) }, block._key),
			};

		case "iframe":
			return isIframeBlock(block) && !pluginTypes.has("iframe")
				? {
						type: "iframeBlock",
						attrs: attrsWithPortableTextKey({ ...iframeEmbedFromAttrs(block) }, block._key),
					}
				: convertCustomBlock(block);

		case "video":
			return isVideoBlock(block) && !pluginTypes.has("video")
				? {
						type: "videoBlock",
						attrs: attrsWithPortableTextKey(videoNodeAttrs(block), block._key),
					}
				: convertCustomBlock(block);

		case "table": {
			const result = portableTextTableToProseMirror(block, {
				path,
				createKey: tableKeys(attrStr(block._key) ?? path),
				spansToInline: (content, markDefs) =>
					convertPTSpans(content, markDefs) as PortableTextTableProseMirrorNode[],
			});
			if (!result.ok) {
				throw new UnsafePortableTextTableError(result.reason, result.raw, result.renderFallback);
			}
			return result.node;
		}

		default: {
			return convertCustomBlock(block);
		}
	}
}

/** One quote from consecutive quote blocks, one paragraph each. */
function convertPTQuote(blocks: PortableTextTextBlock[]): unknown {
	return {
		type: "blockquote",
		content: blocks.map((block) => {
			const content = convertPTSpans(block.children, block.markDefs ?? []);
			return {
				type: "paragraph",
				attrs: attrsWithPortableTextKey(undefined, block._key),
				content: content.length > 0 ? content : undefined,
			};
		}),
	};
}

function convertCustomBlock(block: PortableTextBlock): unknown {
	const record = block as Record<string, unknown>;
	return {
		type: "pluginBlock",
		attrs: {
			blockType: block._type,
			id: attrStr(record.id) ?? attrStr(record.url) ?? "",
			data: customBlockData(block),
			[PORTABLE_TEXT_KEY_ATTR]: block._key,
			[PORTABLE_TEXT_BLOCK_ATTR]: block,
		},
	};
}

function convertPTList(
	items: PortableTextTextBlock[],
	listType: "bullet" | "number",
	context: string,
): unknown {
	// Group items into root-level items (level === 1) and their nested
	// descendants (level > 1). For each root item, all subsequent items with
	// level > 1 belong to its nested subtree — recurse on them with level
	// decremented so the inner pass sees them as its own root level.
	const rootItems: unknown[] = [];
	let i = 0;

	while (i < items.length) {
		const item = items[i]!;
		const level = item.level || 1;

		if (level === 1) {
			const nestedItems: PortableTextTextBlock[] = [];
			i++;
			while (i < items.length && (items[i]!.level || 1) > 1) {
				nestedItems.push(items[i]!);
				i++;
			}
			rootItems.push(
				convertPTListItem(item, nestedItems, listType, `${context}:${rootItems.length}`),
			);
		} else {
			// Nested items with no root item before them get a list item that
			// holds only their nested list, so they keep their levels.
			const nestedItems: PortableTextTextBlock[] = [];
			while (i < items.length && (items[i]!.level || 1) > 1) {
				nestedItems.push(items[i]!);
				i++;
			}
			rootItems.push(
				convertPTListItem(undefined, nestedItems, listType, `${context}:${rootItems.length}`),
			);
		}
	}

	// A list of nested items only can't take their list id: their own list holds it.
	const firstItem = items.find((item) => (item.level || 1) === 1);
	const metadata =
		listType !== "number"
			? undefined
			: firstItem
				? getListMetadata(firstItem, `${context}:${firstItem._key}`)
				: { listId: deriveLegacyListId(context) };

	return {
		type: listType === "bullet" ? "bulletList" : "orderedList",
		attrs: metadata ? { ...metadata, start: metadata.listStart ?? 1 } : undefined,
		content: rootItems,
	};
}

function convertPTListItem(
	item: PortableTextTextBlock | undefined,
	nestedItems: PortableTextTextBlock[],
	parentListType: "bullet" | "number",
	context: string,
): unknown {
	const content: unknown[] = [];

	if (item) {
		const pmContent = convertPTSpans(item.children, item.markDefs || []);
		content.push({
			type: "paragraph",
			attrs: attrsWithPortableTextKey(undefined, item._key),
			content: pmContent.length > 0 ? pmContent : undefined,
		});
	}

	if (nestedItems.length > 0) {
		// The shallowest level in `nestedItems` is the effective root of this
		// item's nested subtree. A new sub-list only starts when we hit
		// another block at that root level with a different `listItem` type;
		// deeper blocks (level > minLevel) belong to the current group as
		// descendants regardless of their own `listItem`. A deep mixed tree
		// like `bullet L1 → number L2 → bullet L3 → number L2` stays nested
		// under B(L2) and preserves its original level on round-trip.
		let minLevel = Infinity;
		for (const ni of nestedItems) {
			const level = ni.level || 2;
			if (level < minLevel) minLevel = level;
		}

		let j = 0;
		while (j < nestedItems.length) {
			const anchorType: "bullet" | "number" = nestedItems[j]!.listItem || parentListType;
			const anchorId =
				anchorType === "number" ? normalizeListId(nestedItems[j]!.listId) : undefined;
			const nestedGroup: PortableTextTextBlock[] = [];

			do {
				nestedGroup.push(nestedItems[j]!);
				j++;
			} while (
				j < nestedItems.length &&
				belongsToNestedGroup(nestedItems[j]!, minLevel, parentListType, anchorType, anchorId)
			);

			if (nestedGroup.length > 0) {
				const adjustedGroup = nestedGroup.map((ni) => ({
					...ni,
					level: (ni.level || 2) - 1,
				}));
				content.push(
					convertPTList(adjustedGroup, anchorType, `${context}:nested:${j - nestedGroup.length}`),
				);
			}
		}
	}

	return {
		type: "listItem",
		content,
	};
}

function convertPTSpans(spans: PortableTextSpan[], markDefs: PortableTextMarkDef[]): unknown[] {
	const nodes: unknown[] = [];
	const markDefsMap = new Map(markDefs.map((md) => [md._key, md]));

	for (const span of spans) {
		if (span._type !== "span") continue;
		const referencedMarkDefs = markDefs.filter((markDef) => span.marks?.includes(markDef._key));

		const parts = span.text.split("\n");

		for (let i = 0; i < parts.length; i++) {
			const text = parts[i]!;

			if (text.length > 0) {
				const marks = [
					...convertPTMarks(span.marks || [], markDefsMap),
					{
						type: PORTABLE_TEXT_SPAN_MARK,
						attrs: { key: span._key, markDefs: referencedMarkDefs },
					},
				];
				const node: { type: string; text: string; marks?: unknown[] } = {
					type: "text",
					text,
				};
				node.marks = marks;
				nodes.push(node);
			}

			if (i < parts.length - 1) {
				nodes.push({
					type: "hardBreak",
					attrs: attrsWithPortableTextKey(undefined, span._key),
				});
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
			case "subscript":
				pmMarks.push({ type: "subscript" });
				break;
			case "superscript":
				pmMarks.push({ type: "superscript" });
				break;
			case "code":
				pmMarks.push({ type: "code" });
				break;
			default: {
				const markDef = markDefs.get(mark);
				if (markDef && markDef._type === "link") {
					pmMarks.push({
						type: "link",
						attrs: {
							href: markDef.href,
							target: markDef.blank ? "_blank" : null,
						},
					});
				} else {
					throw new UnsupportedPortableTextMarksError([
						typeof markDef?._type === "string" ? markDef._type : mark,
					]);
				}
				break;
			}
		}
	}

	return pmMarks;
}
