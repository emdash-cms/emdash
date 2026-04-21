/**
 * Contentful Rich Text → Portable Text converter.
 *
 * Pure function. No EmDash runtime coupling. Takes a Contentful Rich Text
 * document + resolved includes map, returns Portable Text blocks.
 *
 * Handles:
 * - Standard blocks: paragraph, headings, lists, blockquotes, hr, table
 * - Standard marks: bold, italic, underline, code, superscript, subscript
 * - Inline hyperlinks with internal/external detection
 * - Entry hyperlinks and asset hyperlinks (resolved from includes)
 * - Embedded entries: blogCodeBlock, blogEmbeddedHtml, blogImage
 * - Embedded assets (legacy image pattern)
 *
 * Does NOT handle (by design):
 * - Asset download/upload (that's the import source's job)
 * - Heading anchor preservation (application-specific)
 * - HTML sanitization (renderer's responsibility)
 */

export type {
	ContentfulDocument,
	ContentfulNode,
	ContentfulIncludes,
	ContentfulEntry,
	ContentfulAsset,
	PTBlock,
	PTSpan,
	PTMarkDef,
	ConvertOptions,
} from "./types.js";

import type {
	ContentfulDocument,
	ContentfulIncludes,
	ContentfulNode,
	ConvertOptions,
	PTBlock,
	PTMarkDef,
	PTSpan,
} from "./types.js";

import { transformCodeBlock } from "./blocks/code-block.js";
import { transformEmbeddedHtml } from "./blocks/embedded-html.js";
import { transformImageBlock } from "./blocks/image-block.js";
import { sanitizeUri } from "./sanitize.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let keyCounter = 0;
function generateKey(): string {
	return `k${(keyCounter++).toString(36)}`;
}

/** Reset key counter for deterministic output in tests. */
export function resetKeys(): void {
	keyCounter = 0;
}

// ── Contentful node type → PT style mapping ─────────────────────────────────

const HEADING_MAP: Record<string, string> = {
	"heading-1": "h1",
	"heading-2": "h2",
	"heading-3": "h3",
	"heading-4": "h4",
	"heading-5": "h5",
	"heading-6": "h6",
};

const MARK_MAP: Record<string, string> = {
	bold: "strong",
	italic: "em",
	underline: "underline",
	code: "code",
	superscript: "sup",
	subscript: "sub",
};

// ── Main converter ──────────────────────────────────────────────────────────

/**
 * Convert a Contentful Rich Text document to Portable Text blocks.
 */
export function richTextToPortableText(
	document: ContentfulDocument,
	includes: ContentfulIncludes,
	options: ConvertOptions = {},
): PTBlock[] {
	resetKeys();
	const blocks: PTBlock[] = [];

	for (const node of document.content) {
		const converted = convertNode(node, includes, options);
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
): PTBlock | PTBlock[] | null {
	switch (node.nodeType) {
		case "paragraph":
			return convertTextBlock(node, "normal", includes, options);

		case "heading-1":
		case "heading-2":
		case "heading-3":
		case "heading-4":
		case "heading-5":
		case "heading-6":
			return convertTextBlock(
				node,
				HEADING_MAP[node.nodeType]!,
				includes,
				options,
			);

		case "blockquote":
			return convertBlockquote(node, includes, options);

		case "unordered-list":
			return convertList(node, "bullet", includes, options);

		case "ordered-list":
			return convertList(node, "number", includes, options);

		case "hr":
			return { _type: "break", _key: generateKey(), style: "lineBreak" };

		case "table":
			return convertTable(node, includes, options);

		case "embedded-entry-block":
			return convertEmbeddedEntry(node, includes);

		case "embedded-asset-block":
			return convertEmbeddedAsset(node, includes);

		default:
			console.warn(
				`[rich-text-to-pt] Unknown node type: ${node.nodeType}`,
			);
			return null;
	}
}

// ── Text block (paragraph, heading) ─────────────────────────────────────────

function convertTextBlock(
	node: ContentfulNode,
	style: string,
	includes: ContentfulIncludes,
	options: ConvertOptions,
): PTBlock | null {
	const { children, markDefs } = convertInlineContent(
		node.content ?? [],
		includes,
		options,
	);

	// Skip empty paragraphs (Contentful emits these often)
	if (
		style === "normal" &&
		children.length === 1 &&
		children[0]!._type === "span" &&
		(children[0] as PTSpan).text === ""
	) {
		return null;
	}

	return {
		_type: "block",
		_key: generateKey(),
		style,
		children,
		markDefs,
	};
}

// ── Blockquote ──────────────────────────────────────────────────────────────

function convertBlockquote(
	node: ContentfulNode,
	includes: ContentfulIncludes,
	options: ConvertOptions,
): PTBlock[] {
	// Contentful blockquotes contain paragraphs as children.
	// PT blockquotes are blocks with style "blockquote" — one per paragraph.
	const blocks: PTBlock[] = [];
	for (const child of node.content ?? []) {
		if (child.nodeType === "paragraph") {
			const block = convertTextBlock(
				child,
				"blockquote",
				includes,
				options,
			);
			if (block) blocks.push(block);
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
	level: number = 1,
): PTBlock[] {
	const blocks: PTBlock[] = [];

	for (const item of node.content ?? []) {
		if (item.nodeType !== "list-item") continue;

		for (const child of item.content ?? []) {
			if (child.nodeType === "paragraph") {
				const { children, markDefs } = convertInlineContent(
					child.content ?? [],
					includes,
					options,
				);
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "normal",
					listItem,
					level,
					children,
					markDefs,
				});
			} else if (
				child.nodeType === "unordered-list" ||
				child.nodeType === "ordered-list"
			) {
				// Nested list
				const nestedType =
					child.nodeType === "unordered-list" ? "bullet" : "number";
				blocks.push(
					...convertList(
						child,
						nestedType,
						includes,
						options,
						level + 1,
					),
				);
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
): PTBlock {
	const rows: Array<{ _type: string; _key: string; cells: string[] }> = [];

	for (const row of node.content ?? []) {
		if (row.nodeType !== "table-row") continue;
		const cells: string[] = [];
		for (const cell of row.content ?? []) {
			// Extract plain text from cell paragraphs, including
			// text nested inside hyperlinks and other inline nodes
			const text = (cell.content ?? [])
				.flatMap((p) => (p.content ?? []).map(extractText))
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
): PTBlock | null {
	const targetId = (node.data?.target as { sys?: { id?: string } })?.sys?.id;
	if (!targetId) return null;

	const entry = includes.entries.get(targetId);
	if (!entry) {
		console.warn(
			`[rich-text-to-pt] Unresolved embedded entry: ${targetId}`,
		);
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
			// Unknown embedded entry type — skip with warning
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
): PTBlock | null {
	const targetId = (node.data?.target as { sys?: { id?: string } })?.sys?.id;
	if (!targetId) return null;

	const asset = includes.assets.get(targetId);
	if (!asset) {
		console.warn(
			`[rich-text-to-pt] Unresolved embedded asset: ${targetId}`,
		);
		return null;
	}

	return {
		_type: "imageBlock",
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
): { children: Array<PTSpan>; markDefs: PTMarkDef[] } {
	const children: PTSpan[] = [];
	const markDefs: PTMarkDef[] = [];

	for (const node of nodes) {
		if (node.nodeType === "text") {
			const marks = (node.marks ?? [])
				.map((m) => MARK_MAP[m.type] ?? m.type)
				.filter(Boolean);

			children.push({
				_type: "span",
				_key: generateKey(),
				text: node.value ?? "",
				marks,
			});
		} else if (node.nodeType === "hyperlink") {
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

			// Process children of the hyperlink (the link text)
			for (const child of node.content ?? []) {
				if (child.nodeType === "text") {
					const marks = (child.marks ?? [])
						.map((m) => MARK_MAP[m.type] ?? m.type)
						.filter(Boolean);

					children.push({
						_type: "span",
						_key: generateKey(),
						text: child.value ?? "",
						marks: [...marks, markKey],
					});
				}
			}
		} else if (
			node.nodeType === "entry-hyperlink" ||
			node.nodeType === "asset-hyperlink"
		) {
			// Resolve to URL, then treat as regular link
			const targetId = (
				node.data?.target as { sys?: { id?: string } }
			)?.sys?.id;
			let href = "#";

			if (node.nodeType === "entry-hyperlink" && targetId) {
				const entry = includes.entries.get(targetId);
				if (entry?.fields?.slug) {
					href = `/${entry.fields.slug as string}/`;
				}
			} else if (node.nodeType === "asset-hyperlink" && targetId) {
				const asset = includes.assets.get(targetId);
				if (asset?.url) {
					href = asset.url.startsWith("//")
						? `https:${asset.url}`
						: asset.url;
				}
			}

			const markKey = generateKey();
			markDefs.push({ _key: markKey, _type: "link", href });

			for (const child of node.content ?? []) {
				if (child.nodeType === "text") {
					const marks = (child.marks ?? [])
						.map((m) => MARK_MAP[m.type] ?? m.type)
						.filter(Boolean);
					children.push({
						_type: "span",
						_key: generateKey(),
						text: child.value ?? "",
						marks: [...marks, markKey],
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
	if (!uri || !uri.startsWith("http")) return false;
	try {
		const hostname = new URL(uri).hostname;
		if (blogHostname && hostname === blogHostname) return false;
		return true;
	} catch {
		return false;
	}
}

// sanitizeUri imported from ./sanitize.js

/** Recursively extract plain text from a Contentful inline node. */
function extractText(node: ContentfulNode): string {
	if (node.value != null) return node.value;
	// Hyperlinks and other inline wrappers store text in children
	return (node.content ?? []).map(extractText).join("");
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
		const sys = entry.sys as { id: string; contentType?: { sys?: { id?: string } } };
		entries.set(sys.id, {
			id: sys.id,
			contentType: sys.contentType?.sys?.id ?? "unknown",
			fields: (entry.fields as Record<string, unknown>) ?? {},
		});
	}

	for (const asset of raw.Asset ?? []) {
		const sys = asset.sys as { id: string };
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
