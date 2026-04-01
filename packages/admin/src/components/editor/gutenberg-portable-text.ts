/**
 * Bidirectional converters between Gutenberg blocks and Portable Text.
 *
 * Gutenberg stores content as an array of block objects with `name`, `attributes`,
 * and `innerBlocks`. When serialized, it becomes HTML with block delimiter comments.
 *
 * Portable Text is a JSON-based rich text format used by EmDash (similar to Sanity).
 *
 * This module converts between the two so the Gutenberg editor can be used
 * while EmDash continues storing Portable Text internally.
 */

import {
	serialize as serializeBlocks,
	createBlock,
	type BlockInstance,
} from "@wordpress/blocks";

// --- Portable Text types (mirrored from PortableTextEditor.tsx) ---

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
	children: PortableTextSpan[];
	markDefs?: PortableTextMarkDef[];
}

interface PortableTextImageBlock {
	_type: "image";
	_key: string;
	asset: { _ref: string; url?: string };
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
	displayWidth?: number;
	displayHeight?: number;
}

interface PortableTextCodeBlock {
	_type: "code";
	_key: string;
	code: string;
	language?: string;
}

type PortableTextBlock =
	| PortableTextTextBlock
	| PortableTextImageBlock
	| PortableTextCodeBlock
	| { _type: string; _key: string; [key: string]: unknown };

function generateKey(): string {
	return Math.random().toString(36).substring(2, 11);
}

// --- Portable Text → Gutenberg Blocks ---

export function portableTextToGutenberg(blocks: PortableTextBlock[]): BlockInstance[] {
	const result: BlockInstance[] = [];
	let i = 0;

	while (i < blocks.length) {
		const block = blocks[i]!;

		if (block._type === "block") {
			const textBlock = block as PortableTextTextBlock;

			// Collect consecutive list items into a single list block
			if (textBlock.listItem) {
				const listItems: PortableTextTextBlock[] = [];
				const listType = textBlock.listItem;
				while (i < blocks.length) {
					const current = blocks[i] as PortableTextTextBlock;
					if (current?._type === "block" && current.listItem === listType) {
						listItems.push(current);
						i++;
					} else {
						break;
					}
				}
				result.push(convertListToGutenberg(listItems, listType));
				continue;
			}

			// Headings
			if (textBlock.style && textBlock.style.startsWith("h")) {
				const level = parseInt(textBlock.style.substring(1), 10);
				result.push(
					createBlock("core/heading", {
						level,
						content: spansToHTML(textBlock.children, textBlock.markDefs || []),
					}),
				);
				i++;
				continue;
			}

			// Blockquote
			if (textBlock.style === "blockquote") {
				const quoteBlocks: BlockInstance[] = [
					createBlock("core/paragraph", {
						content: spansToHTML(textBlock.children, textBlock.markDefs || []),
					}),
				];
				result.push(
					createBlock("core/quote", {}, quoteBlocks),
				);
				i++;
				continue;
			}

			// Default: paragraph
			result.push(
				createBlock("core/paragraph", {
					content: spansToHTML(textBlock.children, textBlock.markDefs || []),
				}),
			);
			i++;
			continue;
		}

		if (block._type === "image") {
			const imageBlock = block as PortableTextImageBlock;
			const url = imageBlock.asset.url || `/_emdash/api/media/file/${imageBlock.asset._ref}`;
			result.push(
				createBlock("core/image", {
					url,
					alt: imageBlock.alt || "",
					caption: imageBlock.caption || "",
					// Use display dimensions if set, otherwise original
					width: imageBlock.displayWidth || imageBlock.width,
					height: imageBlock.displayHeight || imageBlock.height,
					// Store originals as custom attributes for round-trip
					emdashOriginalWidth: imageBlock.width,
					emdashOriginalHeight: imageBlock.height,
				}),
			);
			i++;
			continue;
		}

		if (block._type === "code") {
			const codeBlock = block as PortableTextCodeBlock;
			result.push(
				createBlock("core/code", {
					content: escapeHTML(codeBlock.code),
					language: codeBlock.language,
				}),
			);
			i++;
			continue;
		}

		if (block._type === "break") {
			result.push(createBlock("core/separator", {}));
			i++;
			continue;
		}

		// Unknown block type - convert to paragraph with a note
		result.push(
			createBlock("core/paragraph", {
				content: `[Unknown block type: ${block._type}]`,
			}),
		);
		i++;
	}

	return result;
}

function convertListToGutenberg(
	items: PortableTextTextBlock[],
	listType: "bullet" | "number",
): BlockInstance {
	const innerBlocks = items.map((item) =>
		createBlock("core/list-item", {
			content: spansToHTML(item.children, item.markDefs || []),
		}),
	);
	return createBlock(
		"core/list",
		{ ordered: listType === "number" },
		innerBlocks,
	);
}

function spansToHTML(spans: PortableTextSpan[], markDefs: PortableTextMarkDef[]): string {
	const markDefsMap = new Map(markDefs.map((md) => [md._key, md]));
	let html = "";

	for (const span of spans) {
		if (span._type !== "span") continue;
		let text = escapeHTML(span.text);

		const marks = span.marks || [];
		for (const mark of marks) {
			const markDef = markDefsMap.get(mark);
			if (markDef && markDef._type === "link") {
				const href = escapeAttr(String(markDef.href || ""));
				const target = markDef.blank ? ' target="_blank"' : "";
				text = `<a href="${href}"${target}>${text}</a>`;
			} else {
				switch (mark) {
					case "strong":
						text = `<strong>${text}</strong>`;
						break;
					case "em":
						text = `<em>${text}</em>`;
						break;
					case "underline":
						text = `<u>${text}</u>`;
						break;
					case "strike-through":
						text = `<s>${text}</s>`;
						break;
					case "code":
						text = `<code>${text}</code>`;
						break;
				}
			}
		}

		html += text;
	}

	return html;
}

function escapeHTML(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Gutenberg Blocks → Portable Text ---

export function gutenbergToPortableText(blocks: BlockInstance[]): PortableTextBlock[] {
	const result: PortableTextBlock[] = [];

	for (const block of blocks) {
		const converted = convertGutenbergBlock(block);
		if (converted) {
			if (Array.isArray(converted)) {
				result.push(...converted);
			} else {
				result.push(converted);
			}
		}
	}

	return result;
}

function convertGutenbergBlock(
	block: BlockInstance,
): PortableTextBlock | PortableTextBlock[] | null {
	switch (block.name) {
		case "core/paragraph": {
			const { children, markDefs } = htmlToSpans(String(block.attributes.content || ""));
			if (children.length === 0) return null;
			return {
				_type: "block",
				_key: generateKey(),
				style: "normal",
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			};
		}

		case "core/heading": {
			const level = typeof block.attributes.level === "number" ? block.attributes.level : 2;
			const { children, markDefs } = htmlToSpans(String(block.attributes.content || ""));
			if (children.length === 0) return null;
			return {
				_type: "block",
				_key: generateKey(),
				style: `h${level}` as PortableTextTextBlock["style"],
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			};
		}

		case "core/list": {
			const ordered = !!block.attributes.ordered;
			const listType = ordered ? "number" : "bullet";
			const items: PortableTextTextBlock[] = [];

			for (const item of block.innerBlocks) {
				if (item.name === "core/list-item") {
					const { children, markDefs } = htmlToSpans(String(item.attributes.content || ""));
					if (children.length > 0) {
						items.push({
							_type: "block",
							_key: generateKey(),
							style: "normal",
							listItem: listType as "bullet" | "number",
							level: 1,
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
					}
				}
			}

			return items.length > 0 ? items : null;
		}

		case "core/quote": {
			const blocks: PortableTextTextBlock[] = [];
			for (const inner of block.innerBlocks) {
				if (inner.name === "core/paragraph") {
					const { children, markDefs } = htmlToSpans(String(inner.attributes.content || ""));
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
			// If no inner blocks, try the value attribute (older format)
			if (blocks.length === 0 && block.attributes.value) {
				const { children, markDefs } = htmlToSpans(String(block.attributes.value));
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
			return blocks.length > 0 ? blocks : null;
		}

		case "core/image": {
			const attrs = block.attributes;
			const originalWidth = typeof attrs.emdashOriginalWidth === "number" ? attrs.emdashOriginalWidth : undefined;
			const originalHeight = typeof attrs.emdashOriginalHeight === "number" ? attrs.emdashOriginalHeight : undefined;
			const currentWidth = typeof attrs.width === "number" ? attrs.width : undefined;
			const currentHeight = typeof attrs.height === "number" ? attrs.height : undefined;

			// If we have originals and current differs, the user resized
			const wasResized = originalWidth && currentWidth && originalWidth !== currentWidth;
			return {
				_type: "image",
				_key: generateKey(),
				asset: {
					_ref: String(attrs.id || ""),
					url: String(attrs.url || ""),
				},
				alt: String(attrs.alt || ""),
				caption: String(attrs.caption || ""),
				width: originalWidth || currentWidth,
				height: originalHeight || currentHeight,
				displayWidth: wasResized ? currentWidth : undefined,
				displayHeight: wasResized ? currentHeight : undefined,
			};
		}

		case "core/code": {
			return {
				_type: "code",
				_key: generateKey(),
				code: unescapeHTML(String(block.attributes.content || "")),
				language: typeof block.attributes.language === "string" ? block.attributes.language : undefined,
			};
		}

		case "core/separator":
			return {
				_type: "break",
				_key: generateKey(),
				style: "lineBreak",
			};

		default:
			return null;
	}
}

/**
 * Simple HTML to Portable Text spans converter.
 * Handles basic inline formatting: <strong>, <em>, <u>, <s>, <code>, <a>.
 * This is intentionally simple — more complex nested HTML is flattened to text.
 */
function htmlToSpans(html: string): {
	children: PortableTextSpan[];
	markDefs: PortableTextMarkDef[];
} {
	if (!html || html.trim() === "") {
		return {
			children: [{ _type: "span", _key: generateKey(), text: "" }],
			markDefs: [],
		};
	}

	const children: PortableTextSpan[] = [];
	const markDefs: PortableTextMarkDef[] = [];
	const markDefMap = new Map<string, string>();

	// Parse HTML using a simple regex-based approach
	// This handles the common cases from Gutenberg output
	parseHTMLInline(html, children, markDefs, markDefMap);

	if (children.length === 0) {
		children.push({ _type: "span", _key: generateKey(), text: "" });
	}

	return { children, markDefs };
}

function parseHTMLInline(
	html: string,
	children: PortableTextSpan[],
	markDefs: PortableTextMarkDef[],
	markDefMap: Map<string, string>,
	activeMarks: string[] = [],
): void {
	// Match tags or text content
	const tagRegex = /<(\/?)(\w+)([^>]*)>|([^<]+)/g;
	let match: RegExpExecArray | null;
	const markStack: string[][] = [activeMarks];

	while ((match = tagRegex.exec(html)) !== null) {
		const [, isClosing, tagName, attrs, textContent] = match;

		if (textContent) {
			// Text node
			const text = unescapeHTML(textContent);
			if (text) {
				const currentMarks = markStack[markStack.length - 1] || [];
				children.push({
					_type: "span",
					_key: generateKey(),
					text,
					marks: currentMarks.length > 0 ? [...currentMarks] : undefined,
				});
			}
			continue;
		}

		if (!tagName) continue;
		const tag = tagName.toLowerCase();

		if (isClosing) {
			// Closing tag — pop marks
			markStack.pop();
			continue;
		}

		// Opening tag — push marks
		const currentMarks = [...(markStack[markStack.length - 1] || [])];
		let newMark: string | null = null;

		switch (tag) {
			case "strong":
			case "b":
				newMark = "strong";
				break;
			case "em":
			case "i":
				newMark = "em";
				break;
			case "u":
				newMark = "underline";
				break;
			case "s":
			case "del":
			case "strike":
				newMark = "strike-through";
				break;
			case "code":
				newMark = "code";
				break;
			case "a": {
				// Extract href from attributes
				const hrefMatch = attrs?.match(/href="([^"]*)"/);
				const href = hrefMatch ? hrefMatch[1] : "";
				const targetMatch = attrs?.match(/target="([^"]*)"/);
				const isBlank = targetMatch?.[1] === "_blank";

				if (href) {
					let markKey = markDefMap.get(href);
					if (!markKey) {
						markKey = generateKey();
						markDefs.push({
							_type: "link",
							_key: markKey,
							href,
							blank: isBlank || undefined,
						});
						markDefMap.set(href, markKey);
					}
					newMark = markKey;
				}
				break;
			}
			case "br":
				// Self-closing, add newline to previous span or create one
				if (children.length > 0) {
					const last = children[children.length - 1]!;
					last.text += "\n";
				} else {
					children.push({
						_type: "span",
						_key: generateKey(),
						text: "\n",
					});
				}
				continue;
		}

		if (newMark) {
			currentMarks.push(newMark);
		}
		markStack.push(currentMarks);
	}
}

function unescapeHTML(str: string): string {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&nbsp;/g, " ");
}

export type { PortableTextBlock };
