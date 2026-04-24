/**
 * ProseMirror to Portable Text Converter
 *
 * Converts TipTap's ProseMirror JSON format to Portable Text for storage.
 */

import type {
	ProseMirrorDocument,
	ProseMirrorNode,
	ProseMirrorMark,
	PortableTextBlock,
	PortableTextTextBlock,
	PortableTextSpan,
	PortableTextMarkDef,
	PortableTextImageBlock,
	PortableTextCodeBlock,
} from "./types.js";

/**
 * Generate a unique key for Portable Text blocks
 */
function generateKey(): string {
	return Math.random().toString(36).substring(2, 11);
}

function extractTextAlign(node: ProseMirrorNode): "center" | "right" | "justify" | undefined {
	const v = node.attrs?.textAlign;
	// "left" is the default; omit so existing payloads stay byte-identical
	if (v === "center" || v === "right" || v === "justify") return v;
	return undefined;
}

/**
 * Convert ProseMirror document to Portable Text
 */
export function prosemirrorToPortableText(doc: ProseMirrorDocument): PortableTextBlock[] {
	if (!doc || doc.type !== "doc" || !doc.content) {
		return [];
	}

	const blocks: PortableTextBlock[] = [];

	for (const node of doc.content) {
		const converted = convertNode(node);
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

/**
 * Convert a single ProseMirror node to Portable Text block(s)
 */
function convertNode(node: ProseMirrorNode): PortableTextBlock | PortableTextBlock[] | null {
	switch (node.type) {
		case "paragraph":
			return convertParagraph(node);

		case "heading":
			return convertHeading(node);

		case "bulletList":
			return convertList(node, "bullet");

		case "orderedList":
			return convertList(node, "number");

		case "blockquote":
			return convertBlockquote(node);

		case "codeBlock":
			return convertCodeBlock(node);

		case "image":
			return convertImage(node);

		case "horizontalRule":
			return {
				_type: "break",
				_key: generateKey(),
				style: "lineBreak",
			};

		default:
			// Preserve unknown blocks
			return {
				_type: node.type,
				_key: generateKey(),
				...node.attrs,
				_pmContent: node.content,
			};
	}
}

/**
 * Convert paragraph to Portable Text block
 */
function convertParagraph(node: ProseMirrorNode): PortableTextTextBlock | null {
	const { children, markDefs } = convertInlineContent(node.content || []);

	// Skip empty paragraphs
	if (children.length === 0) {
		return null;
	}

	const textAlign = extractTextAlign(node);

	return {
		_type: "block",
		_key: generateKey(),
		style: "normal",
		children,
		markDefs: markDefs.length > 0 ? markDefs : undefined,
		...(textAlign ? { textAlign } : {}),
	};
}

/** Map heading level number to Portable Text style */
function headingLevelToStyle(level: number): PortableTextTextBlock["style"] {
	switch (level) {
		case 1:
			return "h1";
		case 2:
			return "h2";
		case 3:
			return "h3";
		case 4:
			return "h4";
		case 5:
			return "h5";
		case 6:
			return "h6";
		default:
			return "h1";
	}
}

/**
 * Convert heading to Portable Text block
 */
function convertHeading(node: ProseMirrorNode): PortableTextTextBlock | null {
	const { children, markDefs } = convertInlineContent(node.content || []);
	const rawLevel = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
	const style = headingLevelToStyle(rawLevel);

	if (children.length === 0) {
		return null;
	}

	const textAlign = extractTextAlign(node);

	return {
		_type: "block",
		_key: generateKey(),
		style,
		children,
		markDefs: markDefs.length > 0 ? markDefs : undefined,
		...(textAlign ? { textAlign } : {}),
	};
}

/**
 * Convert list to Portable Text blocks
 */
function convertList(
	node: ProseMirrorNode,
	listItem: "bullet" | "number",
): PortableTextTextBlock[] {
	const blocks: PortableTextTextBlock[] = [];

	for (const item of node.content || []) {
		if (item.type === "listItem") {
			const itemBlocks = convertListItem(item, listItem, 1);
			blocks.push(...itemBlocks);
		}
	}

	return blocks;
}

/**
 * Convert list item to Portable Text blocks
 */
function convertListItem(
	item: ProseMirrorNode,
	listItem: "bullet" | "number",
	level: number,
): PortableTextTextBlock[] {
	const blocks: PortableTextTextBlock[] = [];

	for (const child of item.content || []) {
		if (child.type === "paragraph") {
			const { children, markDefs } = convertInlineContent(child.content || []);

			if (children.length > 0) {
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "normal",
					listItem,
					level,
					children,
					markDefs: markDefs.length > 0 ? markDefs : undefined,
				});
			}
		} else if (child.type === "bulletList") {
			blocks.push(...convertListItemNested(child, "bullet", level + 1));
		} else if (child.type === "orderedList") {
			blocks.push(...convertListItemNested(child, "number", level + 1));
		}
	}

	return blocks;
}

/**
 * Convert nested list
 */
function convertListItemNested(
	node: ProseMirrorNode,
	listItem: "bullet" | "number",
	level: number,
): PortableTextTextBlock[] {
	const blocks: PortableTextTextBlock[] = [];

	for (const item of node.content || []) {
		if (item.type === "listItem") {
			blocks.push(...convertListItem(item, listItem, level));
		}
	}

	return blocks;
}

/**
 * Convert blockquote to Portable Text blocks
 */
function convertBlockquote(
	node: ProseMirrorNode,
): PortableTextTextBlock | PortableTextTextBlock[] | null {
	// Blockquotes in PT are just blocks with style: "blockquote"
	const blocks: PortableTextTextBlock[] = [];

	for (const child of node.content || []) {
		if (child.type === "paragraph") {
			const { children, markDefs } = convertInlineContent(child.content || []);

			if (children.length > 0) {
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "blockquote",
					children,
					markDefs: markDefs.length > 0 ? markDefs : undefined,
				});
			}
		}
	}

	return blocks.length === 1 ? blocks[0] : blocks.length > 0 ? blocks : null;
}

/**
 * Convert code block to Portable Text
 */
function convertCodeBlock(node: ProseMirrorNode): PortableTextCodeBlock {
	const code = node.content?.map((n) => n.text || "").join("") || "";
	const language = typeof node.attrs?.language === "string" ? node.attrs.language : undefined;

	return {
		_type: "code",
		_key: generateKey(),
		code,
		language: language || undefined,
	};
}

/**
 * Convert image to Portable Text
 */
function convertImage(node: ProseMirrorNode): PortableTextImageBlock {
	const attrs = node.attrs;
	const provider = typeof attrs?.provider === "string" ? attrs.provider : undefined;
	const mediaId = typeof attrs?.mediaId === "string" ? attrs.mediaId : undefined;
	const src = typeof attrs?.src === "string" ? attrs.src : "";
	const alt = typeof attrs?.alt === "string" ? attrs.alt : undefined;
	const title = typeof attrs?.title === "string" ? attrs.title : undefined;
	const width = typeof attrs?.width === "number" ? attrs.width : undefined;
	const height = typeof attrs?.height === "number" ? attrs.height : undefined;
	const displayWidth = typeof attrs?.displayWidth === "number" ? attrs.displayWidth : undefined;
	const displayHeight = typeof attrs?.displayHeight === "number" ? attrs.displayHeight : undefined;

	return {
		_type: "image",
		_key: generateKey(),
		asset: {
			// Use mediaId as _ref if available (for proper provider lookups)
			_ref: mediaId || src || "",
			// Store URL for admin preview and fallback rendering
			url: src || "",
			// Store provider for external media
			provider: provider && provider !== "local" ? provider : undefined,
		},
		alt: alt || undefined,
		caption: title || undefined,
		width: width || undefined,
		height: height || undefined,
		displayWidth: displayWidth || undefined,
		displayHeight: displayHeight || undefined,
	};
}

/**
 * Convert inline content (text nodes with marks) to Portable Text spans
 */
function convertInlineContent(nodes: ProseMirrorNode[]): {
	children: PortableTextSpan[];
	markDefs: PortableTextMarkDef[];
} {
	const children: PortableTextSpan[] = [];
	const markDefs: PortableTextMarkDef[] = [];
	const markDefMap = new Map<string, string>(); // href -> key

	for (const node of nodes) {
		if (node.type === "text" && node.text) {
			const marks: string[] = [];

			for (const mark of node.marks || []) {
				const markType = convertMark(mark, markDefs, markDefMap);
				if (markType) {
					marks.push(markType);
				}
			}

			children.push({
				_type: "span",
				_key: generateKey(),
				text: node.text,
				marks: marks.length > 0 ? marks : undefined,
			});
		} else if (node.type === "hardBreak") {
			// Hard breaks become newlines in the text
			if (children.length > 0) {
				const lastChild = children.at(-1)!;
				lastChild.text += "\n";
			} else {
				children.push({
					_type: "span",
					_key: generateKey(),
					text: "\n",
				});
			}
		}
	}

	// Ensure at least one span exists
	if (children.length === 0) {
		children.push({
			_type: "span",
			_key: generateKey(),
			text: "",
		});
	}

	return { children, markDefs };
}

/**
 * Convert a ProseMirror mark to Portable Text mark
 */
function convertMark(
	mark: ProseMirrorMark,
	markDefs: PortableTextMarkDef[],
	markDefMap: Map<string, string>,
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

		case "code":
			return "code";

		case "link": {
			const href = (typeof mark.attrs?.href === "string" ? mark.attrs.href : "") || "";

			// Check if we already have a mark def for this link
			if (markDefMap.has(href)) {
				return markDefMap.get(href)!;
			}

			// Create new mark def
			const key = generateKey();
			markDefs.push({
				_type: "link",
				_key: key,
				href,
				blank: mark.attrs?.target === "_blank",
			});
			markDefMap.set(href, key);

			return key;
		}

		default:
			// Unknown mark - preserve as-is
			return mark.type;
	}
}
