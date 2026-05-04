/**
 * Portable Text to ProseMirror Converter
 *
 * Converts Portable Text to TipTap's ProseMirror JSON format for editing.
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
 * Convert Portable Text to ProseMirror document
 */
export function portableTextToProsemirror(blocks: PortableTextBlock[]): ProseMirrorDocument {
	if (!blocks || blocks.length === 0) {
		return {
			type: "doc",
			content: [{ type: "paragraph" }],
		};
	}

	const content: ProseMirrorNode[] = [];
	let i = 0;

	while (i < blocks.length) {
		const block = blocks[i];

		// Check for list items
		if (isTextBlock(block) && block.listItem) {
			// Collect consecutive list items
			const listBlocks: PortableTextTextBlock[] = [];
			const listType = block.listItem;

			while (i < blocks.length) {
				const current = blocks[i];
				if (isTextBlock(current) && current.listItem === listType) {
					listBlocks.push(current);
					i++;
				} else {
					break;
				}
			}

			content.push(convertList(listBlocks, listType));
		} else {
			const converted = convertBlock(block);
			if (converted) {
				content.push(converted);
			}
			i++;
		}
	}

	return {
		type: "doc",
		content: content.length > 0 ? content : [{ type: "paragraph" }],
	};
}

/**
 * Type guard for text blocks
 */
function isTextBlock(block: PortableTextBlock): block is PortableTextTextBlock {
	return block._type === "block";
}

/**
 * Type guard for image blocks.
 * Checks both `_type` and that `asset` is a valid object — image blocks
 * without an `asset` wrapper (e.g. `{ _type: "image", url: "..." }`) are
 * malformed and should not be cast to `PortableTextImageBlock`.
 */
function isImageBlock(block: PortableTextBlock): block is PortableTextImageBlock {
	return (
		block._type === "image" &&
		"asset" in block &&
		typeof block.asset === "object" &&
		block.asset !== null
	);
}

/**
 * Type guard for code blocks
 */
function isCodeBlock(block: PortableTextBlock): block is PortableTextCodeBlock {
	return block._type === "code";
}

/**
 * Convert a single Portable Text block to ProseMirror node
 */
function convertBlock(block: PortableTextBlock): ProseMirrorNode | null {
	if (isTextBlock(block)) {
		return convertTextBlock(block);
	}
	if (isImageBlock(block)) {
		return convertImage(block);
	}
	if (block._type === "image") {
		// Malformed image block (no asset wrapper) — extract url from top level
		return convertMalformedImage(block);
	}
	if (isCodeBlock(block)) {
		return convertCodeBlock(block);
	}
	if (block._type === "break") {
		return { type: "horizontalRule" };
	}
	// Unknown block - wrap in a div or preserve as placeholder
	return {
		type: "paragraph",
		content: [
			{
				type: "text",
				text: `[Unknown block type: ${block._type}]`,
				marks: [{ type: "code" }],
			},
		],
	};
}

/**
 * Convert text block to ProseMirror paragraph or heading
 */
function convertTextBlock(block: PortableTextTextBlock): ProseMirrorNode | null {
	const { style = "normal", children, markDefs = [], textAlign } = block;

	// Convert children to ProseMirror nodes
	const content = convertSpans(children, markDefs);

	// Determine node type based on style
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
				attrs: { level, ...(textAlign ? { textAlign } : {}) },
				content: content.length > 0 ? content : undefined,
			};
		}

		case "blockquote":
			return {
				type: "blockquote",
				content: [
					{
						type: "paragraph",
						attrs: textAlign ? { textAlign } : undefined,
						content: content.length > 0 ? content : undefined,
					},
				],
			};

		case "normal":
		default:
			return {
				type: "paragraph",
				attrs: textAlign ? { textAlign } : undefined,
				content: content.length > 0 ? content : undefined,
			};
	}
}

/**
 * Convert list items to ProseMirror list
 */
function convertList(
	items: PortableTextTextBlock[],
	listType: "bullet" | "number",
): ProseMirrorNode {
	// Group items by level
	const rootItems: ProseMirrorNode[] = [];
	let i = 0;

	while (i < items.length) {
		const item = items[i];
		const level = item.level || 1;

		if (level === 1) {
			// Collect nested items for this root item
			const nestedItems: PortableTextTextBlock[] = [];
			i++;

			while (i < items.length && (items[i].level || 1) > 1) {
				nestedItems.push(items[i]);
				i++;
			}

			rootItems.push(convertListItem(item, nestedItems, listType));
		} else {
			// Orphan nested item - treat as root
			rootItems.push(convertListItem(item, [], listType));
			i++;
		}
	}

	return {
		type: listType === "bullet" ? "bulletList" : "orderedList",
		content: rootItems,
	};
}

/**
 * Convert a single list item to ProseMirror
 */
function convertListItem(
	item: PortableTextTextBlock,
	nestedItems: PortableTextTextBlock[],
	parentListType: "bullet" | "number",
): ProseMirrorNode {
	const content: ProseMirrorNode[] = [];

	// Add paragraph content
	const spans = convertSpans(item.children, item.markDefs || []);
	content.push({
		type: "paragraph",
		content: spans.length > 0 ? spans : undefined,
	});

	// Handle nested items
	if (nestedItems.length > 0) {
		// Group nested items by their list type
		let j = 0;

		while (j < nestedItems.length) {
			const nestedListType = nestedItems[j].listItem || parentListType;
			const nestedGroup: PortableTextTextBlock[] = [];

			while (
				j < nestedItems.length &&
				(nestedItems[j].listItem || parentListType) === nestedListType
			) {
				nestedGroup.push(nestedItems[j]);
				j++;
			}

			if (nestedGroup.length > 0) {
				// Decrease level for nested conversion
				const adjustedGroup = nestedGroup.map((ni) => ({
					...ni,
					level: (ni.level || 2) - 1,
				}));
				content.push(convertList(adjustedGroup, nestedListType));
			}
		}
	}

	return {
		type: "listItem",
		content,
	};
}

/**
 * Convert Portable Text spans to ProseMirror text nodes
 */
function convertSpans(
	spans: PortableTextSpan[],
	markDefs: PortableTextMarkDef[],
): ProseMirrorNode[] {
	const nodes: ProseMirrorNode[] = [];
	const markDefsMap = new Map(markDefs.map((md) => [md._key, md]));

	for (const span of spans) {
		if (span._type !== "span") continue;

		// Handle newlines in text
		const parts = span.text.split("\n");

		for (let i = 0; i < parts.length; i++) {
			const text = parts[i];

			// Add text node
			if (text.length > 0) {
				const marks = convertMarks(span.marks || [], markDefsMap);
				const node: ProseMirrorNode = {
					type: "text",
					text,
				};
				if (marks.length > 0) {
					node.marks = marks;
				}
				nodes.push(node);
			}

			// Add hard break between parts (not after last)
			if (i < parts.length - 1) {
				nodes.push({ type: "hardBreak" });
			}
		}
	}

	return nodes;
}

/**
 * Convert Portable Text marks to ProseMirror marks
 */
function convertMarks(
	marks: string[],
	markDefs: Map<string, PortableTextMarkDef>,
): ProseMirrorMark[] {
	const pmMarks: ProseMirrorMark[] = [];

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

			case "code":
				pmMarks.push({ type: "code" });
				break;

			default: {
				// Check if it's a mark definition reference
				const markDef = markDefs.get(mark);
				if (markDef) {
					if (markDef._type === "link") {
						pmMarks.push({
							type: "link",
							attrs: {
								href: markDef.href,
								target: markDef.blank ? "_blank" : null,
							},
						});
					} else {
						// Unknown mark def type - preserve attrs
						pmMarks.push({
							type: markDef._type,
							attrs: markDef as Record<string, unknown>,
						});
					}
				}
				break;
			}
		}
	}

	return pmMarks;
}

/**
 * Convert image block to ProseMirror
 */
function convertImage(block: PortableTextImageBlock): ProseMirrorNode {
	return {
		type: "image",
		attrs: {
			src: block.asset.url || block.asset._ref,
			alt: block.alt || "",
			title: block.caption || "",
			mediaId: block.asset._ref,
			provider: block.asset.provider,
			width: block.width,
			height: block.height,
			displayWidth: block.displayWidth,
			displayHeight: block.displayHeight,
		},
	};
}

/**
 * Convert a malformed image block (missing `asset` wrapper) to ProseMirror.
 * Handles blocks like `{ _type: "image", url: "...", alt: "..." }` that may
 * originate from migrations or third-party imports.
 */
function convertMalformedImage(block: PortableTextBlock): ProseMirrorNode {
	// PortableTextUnknownBlock allows indexed access via [key: string]: unknown
	const url = "url" in block && typeof block.url === "string" ? block.url : "";
	const alt = "alt" in block && typeof block.alt === "string" ? block.alt : "";
	const caption = "caption" in block && typeof block.caption === "string" ? block.caption : "";
	const width = "width" in block && typeof block.width === "number" ? block.width : undefined;
	const height = "height" in block && typeof block.height === "number" ? block.height : undefined;
	const displayWidth =
		"displayWidth" in block && typeof block.displayWidth === "number"
			? block.displayWidth
			: undefined;
	const displayHeight =
		"displayHeight" in block && typeof block.displayHeight === "number"
			? block.displayHeight
			: undefined;
	return {
		type: "image",
		attrs: {
			src: url,
			alt,
			title: caption,
			mediaId: undefined,
			provider: undefined,
			width,
			height,
			displayWidth,
			displayHeight,
		},
	};
}

/**
 * Convert code block to ProseMirror
 */
function convertCodeBlock(block: PortableTextCodeBlock): ProseMirrorNode {
	return {
		type: "codeBlock",
		attrs: {
			language: block.language || null,
		},
		content: block.code ? [{ type: "text", text: block.code }] : undefined,
	};
}
