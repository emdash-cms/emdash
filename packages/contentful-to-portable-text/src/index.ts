/**
 * Contentful Rich Text → Portable Text converter.
 *
 * Takes a Contentful Rich Text document + resolved includes map, returns
 * Portable Text blocks. Uses canonical types from @contentful/rich-text-types
 * and @portabletext/types.
 *
 * Handles:
 * - Standard blocks: paragraph, headings, lists, blockquotes, hr, table
 * - Standard marks: bold, italic, underline, code, superscript, subscript, strikethrough
 * - Inline hyperlinks with internal/external detection
 * - Entry hyperlinks and asset hyperlinks (resolved from includes)
 * - Embedded entries: blogCodeBlock, blogEmbeddedHtml, blogImage (block-level)
 * - Embedded inline entries and assets (preserved as custom PT blocks)
 * - Embedded assets (legacy image pattern)
 *
 * Does NOT handle (by design):
 * - Asset download/upload (that's the import source's job)
 * - Heading anchor preservation (application-specific)
 * - HTML sanitization (renderer's responsibility)
 */

// Re-export our own types + canonical types for consumer convenience
export type {
	ContentfulIncludes,
	ContentfulEntry,
	ContentfulAsset,
	ConvertOptions,
} from "./types.js";
export type { Document, Block, Inline, Text } from "@contentful/rich-text-types";
export type {
	PortableTextBlock,
	PortableTextSpan,
	PortableTextMarkDefinition,
	ArbitraryTypedObject,
} from "@portabletext/types";

import type { Document, Block, Inline, Text } from "@contentful/rich-text-types";
import { BLOCKS, INLINES, MARKS } from "@contentful/rich-text-types";
import type {
	ArbitraryTypedObject,
	PortableTextBlock,
	PortableTextMarkDefinition,
	PortableTextSpan,
} from "@portabletext/types";

import { transformCodeBlock } from "./blocks/code-block.js";
import { transformEmbeddedHtml } from "./blocks/embedded-html.js";
import { transformImageBlock } from "./blocks/image-block.js";
import { sanitizeUri } from "./sanitize.js";
import type { ContentfulIncludes, ConvertOptions } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Any Contentful Rich Text node (block, inline, or text) */
type ContentfulNode = Block | Inline | Text;

/** Inline child: either a text span or a custom inline object (e.g. inlineEntry) */
type InlineChild = PortableTextSpan | ArbitraryTypedObject;

/** Output block: either a standard PT block or a custom typed object */
type OutputBlock = PortableTextBlock | ArbitraryTypedObject;

/**
 * Create a call-scoped key generator.
 *
 * Each invocation of richTextToPortableText gets its own counter so that
 * concatenating the output of multiple calls (e.g. body + sidebar, or
 * stitching multi-locale documents) never produces duplicate _key values.
 */
function createKeyGenerator(): () => string {
	let n = 0;
	return () => `k${(n++).toString(36)}`;
}

// ── Contentful node type → PT style mapping ─────────────────────────────────

const HEADING_MAP: Record<string, string> = {
	[BLOCKS.HEADING_1]: "h1",
	[BLOCKS.HEADING_2]: "h2",
	[BLOCKS.HEADING_3]: "h3",
	[BLOCKS.HEADING_4]: "h4",
	[BLOCKS.HEADING_5]: "h5",
	[BLOCKS.HEADING_6]: "h6",
};

const MARK_MAP: Record<string, string> = {
	[MARKS.BOLD]: "strong",
	[MARKS.ITALIC]: "em",
	[MARKS.UNDERLINE]: "underline",
	[MARKS.CODE]: "code",
	[MARKS.SUPERSCRIPT]: "sup",
	[MARKS.SUBSCRIPT]: "sub",
	[MARKS.STRIKETHROUGH]: "s",
};

// ── Main converter ──────────────────────────────────────────────────────────

/**
 * Convert a Contentful Rich Text document to Portable Text blocks.
 */
export function richTextToPortableText(
	document: Document,
	includes: ContentfulIncludes,
	options: ConvertOptions = {},
): OutputBlock[] {
	const generateKey = createKeyGenerator();
	const blocks: OutputBlock[] = [];

	for (const node of document.content) {
		const converted = convertNode(node, includes, options, generateKey);
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

// ── Node dispatcher ─────────────────────────────────────────────────────────

function convertNode(
	node: ContentfulNode,
	includes: ContentfulIncludes,
	options: ConvertOptions,
	generateKey: () => string,
): OutputBlock | OutputBlock[] | null {
	switch (node.nodeType) {
		case BLOCKS.PARAGRAPH:
			return convertTextBlock(node, "normal", includes, options, generateKey);

		case BLOCKS.HEADING_1:
		case BLOCKS.HEADING_2:
		case BLOCKS.HEADING_3:
		case BLOCKS.HEADING_4:
		case BLOCKS.HEADING_5:
		case BLOCKS.HEADING_6:
			return convertTextBlock(node, HEADING_MAP[node.nodeType]!, includes, options, generateKey);

		case BLOCKS.QUOTE:
			return convertBlockquote(node, includes, options, generateKey);

		case BLOCKS.UL_LIST:
			return convertList(node, "bullet", includes, options, generateKey);

		case BLOCKS.OL_LIST:
			return convertList(node, "number", includes, options, generateKey);

		case BLOCKS.HR:
			return { _type: "break", _key: generateKey(), style: "lineBreak" };

		case BLOCKS.TABLE:
			return convertTable(node, includes, options, generateKey);

		case BLOCKS.EMBEDDED_ENTRY:
			return convertEmbeddedEntry(node, includes, generateKey);

		case BLOCKS.EMBEDDED_ASSET:
			return convertEmbeddedAsset(node, includes, generateKey);

		case BLOCKS.EMBEDDED_RESOURCE:
			console.warn(
				`[rich-text-to-pt] Embedded resource block encountered — resource links are not yet supported.`,
			);
			return null;

		default:
			console.warn(`[rich-text-to-pt] Unknown node type: ${node.nodeType}`);
			return null;
	}
}

// ── Text block (paragraph, heading) ─────────────────────────────────────────

function convertTextBlock(
	node: ContentfulNode,
	style: string,
	includes: ContentfulIncludes,
	options: ConvertOptions,
	generateKey: () => string,
): OutputBlock | null {
	const content = "content" in node ? (node.content as ContentfulNode[]) : [];
	const { children, markDefs } = convertInlineContent(content, includes, options, generateKey);

	// Skip empty paragraphs (Contentful emits these often)
	if (
		style === "normal" &&
		children.length === 1 &&
		children[0]!._type === "span" &&
		(children[0] as PortableTextSpan).text === ""
	) {
		return null;
	}

	return {
		_type: "block",
		_key: generateKey(),
		style,
		children,
		...(markDefs.length > 0 ? { markDefs } : {}),
	};
}

// ── Blockquote ──────────────────────────────────────────────────────────────

function convertBlockquote(
	node: ContentfulNode,
	includes: ContentfulIncludes,
	options: ConvertOptions,
	generateKey: () => string,
): OutputBlock[] {
	const content = "content" in node ? (node.content as ContentfulNode[]) : [];
	const blocks: OutputBlock[] = [];
	for (const child of content) {
		if (child.nodeType === BLOCKS.PARAGRAPH) {
			const block = convertTextBlock(child, "blockquote", includes, options, generateKey);
			if (block) blocks.push(block);
		} else {
			// Blockquotes can contain lists, embedded entries, etc.
			const converted = convertNode(child, includes, options, generateKey);
			if (converted) {
				if (Array.isArray(converted)) blocks.push(...converted);
				else blocks.push(converted);
			}
		}
	}
	return blocks;
}

// ── Lists ───────────────────────────────────────────────────────────────────

function convertList(
	node: ContentfulNode,
	listItem: "bullet" | "number",
	includes: ContentfulIncludes,
	options: ConvertOptions,
	generateKey: () => string,
	level: number = 1,
): OutputBlock[] {
	const content = "content" in node ? (node.content as ContentfulNode[]) : [];
	const blocks: OutputBlock[] = [];

	for (const item of content) {
		if (item.nodeType !== BLOCKS.LIST_ITEM) continue;
		const itemContent = "content" in item ? (item.content as ContentfulNode[]) : [];

		for (const child of itemContent) {
			if (child.nodeType === BLOCKS.PARAGRAPH) {
				const childContent = "content" in child ? (child.content as ContentfulNode[]) : [];
				const { children, markDefs } = convertInlineContent(
					childContent,
					includes,
					options,
					generateKey,
				);
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "normal",
					listItem,
					level,
					children,
					...(markDefs.length > 0 ? { markDefs } : {}),
				});
			} else if (child.nodeType === BLOCKS.UL_LIST || child.nodeType === BLOCKS.OL_LIST) {
				const nestedType = child.nodeType === BLOCKS.UL_LIST ? "bullet" : "number";
				blocks.push(...convertList(child, nestedType, includes, options, generateKey, level + 1));
			} else {
				// List items can contain embedded entries, blockquotes, etc.
				const converted = convertNode(child, includes, options, generateKey);
				if (converted) {
					if (Array.isArray(converted)) blocks.push(...converted);
					else blocks.push(converted);
				}
			}
		}
	}

	return blocks;
}

// ── Table ───────────────────────────────────────────────────────────────────

function convertTable(
	node: ContentfulNode,
	_includes: ContentfulIncludes,
	_options: ConvertOptions,
	generateKey: () => string,
): OutputBlock {
	const content = "content" in node ? (node.content as ContentfulNode[]) : [];
	const rows: Array<{ _type: string; _key: string; cells: string[] }> = [];

	for (const row of content) {
		if (row.nodeType !== BLOCKS.TABLE_ROW) continue;
		const rowContent = "content" in row ? (row.content as ContentfulNode[]) : [];
		const cells: string[] = [];
		for (const cell of rowContent) {
			const cellContent = "content" in cell ? (cell.content as ContentfulNode[]) : [];
			const text = cellContent
				.flatMap((p) => {
					const pContent = "content" in p ? (p.content as ContentfulNode[]) : [];
					return pContent.map(extractText);
				})
				.join("");
			cells.push(text);
		}
		rows.push({ _type: "tableRow", _key: generateKey(), cells });
	}

	return { _type: "table", _key: generateKey(), rows };
}

// ── Embedded entry ──────────────────────────────────────────────────────────

function convertEmbeddedEntry(
	node: ContentfulNode,
	includes: ContentfulIncludes,
	generateKey: () => string,
): OutputBlock | null {
	const targetId = (node.data?.target as { sys?: { id?: string } })?.sys?.id;
	if (!targetId) return null;

	const entry = includes.entries.get(targetId);
	if (!entry) {
		console.warn(`[rich-text-to-pt] Unresolved embedded entry: ${targetId}`);
		return null;
	}

	switch (entry.contentType) {
		case "blogCodeBlock":
			return transformCodeBlock(entry, generateKey());

		case "blogEmbeddedHtml":
			return transformEmbeddedHtml(entry, generateKey());

		case "blogImage":
			return transformImageBlock(entry, includes, generateKey());

		default:
			console.warn(
				`[rich-text-to-pt] Unknown embedded entry type: ${entry.contentType} (id: ${entry.id})`,
			);
			return null;
	}
}

// ── Embedded asset (legacy image) ───────────────────────────────────────────

function convertEmbeddedAsset(
	node: ContentfulNode,
	includes: ContentfulIncludes,
	generateKey: () => string,
): OutputBlock | null {
	const targetId = (node.data?.target as { sys?: { id?: string } })?.sys?.id;
	if (!targetId) return null;

	const asset = includes.assets.get(targetId);
	if (!asset) {
		console.warn(`[rich-text-to-pt] Unresolved embedded asset: ${targetId}`);
		return null;
	}

	return {
		_type: "image",
		_key: generateKey(),
		asset: {
			src: asset.url.startsWith("//") ? `https:${asset.url}` : asset.url,
			alt: asset.description ?? asset.title ?? "",
			width: asset.width,
			height: asset.height,
		},
	};
}

// ── Inline content (spans + marks + links) ──────────────────────────────────

function convertInlineContent(
	nodes: ContentfulNode[],
	includes: ContentfulIncludes,
	options: ConvertOptions,
	generateKey: () => string,
): { children: InlineChild[]; markDefs: PortableTextMarkDefinition[] } {
	const children: InlineChild[] = [];
	const markDefs: PortableTextMarkDefinition[] = [];

	for (const node of nodes) {
		if (node.nodeType === "text") {
			const marks = ((node as { marks?: Array<{ type: string }> }).marks ?? [])
				.map((m) => MARK_MAP[m.type] ?? m.type)
				.filter(Boolean);

			children.push({
				_type: "span",
				_key: generateKey(),
				text: (node as { value?: string }).value ?? "",
				marks,
			});
		} else if (node.nodeType === INLINES.HYPERLINK) {
			const rawUri = (node.data?.uri as string) ?? "";
			const href = sanitizeUri(rawUri);
			const markKey = generateKey();
			const isExternal = isExternalLink(href, options.blogHostname);

			markDefs.push({
				_key: markKey,
				_type: "link",
				href,
				...(isExternal ? { blank: true } : {}),
			});

			const linkContent = "content" in node ? (node.content as ContentfulNode[]) : [];
			for (const child of linkContent) {
				if (child.nodeType === "text") {
					const marks = ((child as { marks?: Array<{ type: string }> }).marks ?? [])
						.map((m) => MARK_MAP[m.type] ?? m.type)
						.filter(Boolean);

					children.push({
						_type: "span",
						_key: generateKey(),
						text: (child as { value?: string }).value ?? "",
						marks: [...marks, markKey],
					});
				}
			}
		} else if (
			node.nodeType === INLINES.ENTRY_HYPERLINK ||
			node.nodeType === INLINES.ASSET_HYPERLINK
		) {
			const targetId = (node.data?.target as { sys?: { id?: string } })?.sys?.id;
			let href = "#";

			if (node.nodeType === INLINES.ENTRY_HYPERLINK && targetId) {
				const entry = includes.entries.get(targetId);
				if (entry) {
					const rawHref = options.entryHrefResolver
						? options.entryHrefResolver(entry)
						: entry.fields.slug
							? `/${entry.fields.slug as string}/`
							: "#";
					href = sanitizeUri(rawHref);
				}
			} else if (node.nodeType === INLINES.ASSET_HYPERLINK && targetId) {
				const asset = includes.assets.get(targetId);
				if (asset?.url) {
					const rawUrl = asset.url.startsWith("//") ? `https:${asset.url}` : asset.url;
					href = sanitizeUri(rawUrl);
				}
			}

			const markKey = generateKey();
			markDefs.push({ _key: markKey, _type: "link", href });

			const linkContent = "content" in node ? (node.content as ContentfulNode[]) : [];
			for (const child of linkContent) {
				if (child.nodeType === "text") {
					const marks = ((child as { marks?: Array<{ type: string }> }).marks ?? [])
						.map((m) => MARK_MAP[m.type] ?? m.type)
						.filter(Boolean);
					children.push({
						_type: "span",
						_key: generateKey(),
						text: (child as { value?: string }).value ?? "",
						marks: [...marks, markKey],
					});
				}
			}
		} else if (
			node.nodeType === INLINES.EMBEDDED_ENTRY ||
			node.nodeType === INLINES.EMBEDDED_RESOURCE
		) {
			const targetId = (node.data?.target as { sys?: { id?: string } })?.sys?.id;
			console.warn(
				`[rich-text-to-pt] Inline ${node.nodeType} encountered (target: ${targetId ?? "unknown"}). ` +
					`Preserved as custom inline block — consumer should handle or strip.`,
			);

			children.push({
				_type: node.nodeType === INLINES.EMBEDDED_ENTRY ? "inlineEntry" : "inlineResource",
				_key: generateKey(),
				referenceId: targetId ?? "",
			});
		} else if (node.nodeType === INLINES.RESOURCE_HYPERLINK) {
			// Can't resolve the href, but preserve the visible text
			console.warn(
				`[rich-text-to-pt] Resource hyperlink encountered — link dropped, text preserved.`,
			);
			const linkContent = "content" in node ? (node.content as ContentfulNode[]) : [];
			for (const child of linkContent) {
				if (child.nodeType === "text") {
					const marks = ((child as { marks?: Array<{ type: string }> }).marks ?? [])
						.map((m) => MARK_MAP[m.type] ?? m.type)
						.filter(Boolean);
					children.push({
						_type: "span",
						_key: generateKey(),
						text: (child as { value?: string }).value ?? "",
						marks,
					});
				}
			}
		}
	}

	// Ensure at least one child (PT requires non-empty children array)
	if (children.length === 0) {
		children.push({
			_type: "span",
			_key: generateKey(),
			text: "",
			marks: [],
		});
	}

	return { children, markDefs };
}

// ── Link classification ─────────────────────────────────────────────────────

function isExternalLink(uri: string, blogHostname?: string): boolean {
	if (!uri || uri === "#") return false;
	// Defense-in-depth: sanitizeUri already blocks //-prefixed URLs, but
	// this check guards against direct callers or future call-order changes.
	if (uri.startsWith("//")) return true;
	if (!uri.startsWith("http")) return false;

	try {
		const hostname = new URL(uri).hostname;
		if (blogHostname && hostname === blogHostname) return false;
		return true;
	} catch {
		return false;
	}
}

/** Recursively extract plain text from a Contentful inline node. */
function extractText(node: ContentfulNode): string {
	if ("value" in node && node.value != null) return node.value;
	const content = "content" in node ? (node.content as ContentfulNode[]) : [];
	return content.map(extractText).join("");
}

// ── Build includes map from raw Contentful response ─────────────────────────

/**
 * Build typed includes maps from a raw Contentful API response.
 * Call this once per response, pass the result to richTextToPortableText.
 *
 * Works with both CDA responses (`includes.Entry[]`) and items arrays.
 */
export function buildIncludes(raw: {
	Entry?: Array<Record<string, unknown>>;
	Asset?: Array<Record<string, unknown>>;
}): ContentfulIncludes {
	const entries = new Map<string, import("./types.js").ContentfulEntry>();
	const assets = new Map<string, import("./types.js").ContentfulAsset>();

	for (const entry of raw.Entry ?? []) {
		const sys = entry.sys as { id?: string; contentType?: { sys?: { id?: string } } } | undefined;
		if (!sys?.id) continue;
		entries.set(sys.id, {
			id: sys.id,
			contentType: sys.contentType?.sys?.id ?? "unknown",
			fields: (entry.fields as Record<string, unknown>) ?? {},
		});
	}

	for (const asset of raw.Asset ?? []) {
		const sys = asset.sys as { id?: string } | undefined;
		if (!sys?.id) continue;
		const fields = asset.fields as Record<string, unknown> | undefined;
		const file = fields?.file as
			| {
					url?: string;
					contentType?: string;
					details?: { image?: { width?: number; height?: number } };
			  }
			| undefined;
		assets.set(sys.id, {
			id: sys.id,
			title: fields?.title as string | undefined,
			description: fields?.description as string | undefined,
			url: file?.url ?? "",
			width: file?.details?.image?.width,
			height: file?.details?.image?.height,
			contentType: file?.contentType,
		});
	}

	return { entries, assets };
}
