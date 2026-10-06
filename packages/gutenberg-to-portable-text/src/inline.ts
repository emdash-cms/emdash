/**
 * Inline HTML to Portable Text spans converter
 *
 * Parses inline HTML elements (strong, em, a, code, etc.) and converts
 * them to Portable Text spans with marks.
 */

import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import type { PortableTextSpan, PortableTextMarkDef } from "./types.js";
import { sanitizeHref } from "./url.js";

// Regex patterns for inline parsing
const WHITESPACE_PATTERN = /\S/;

// Pre-compiled block tag patterns
const BLOCK_TAG_PATTERNS: Record<string, { open: RegExp; close: RegExp }> = {
	p: { open: /^<p[^>]*>/i, close: /<\/p>$/i },
	h1: { open: /^<h1[^>]*>/i, close: /<\/h1>$/i },
	h2: { open: /^<h2[^>]*>/i, close: /<\/h2>$/i },
	h3: { open: /^<h3[^>]*>/i, close: /<\/h3>$/i },
	h4: { open: /^<h4[^>]*>/i, close: /<\/h4>$/i },
	h5: { open: /^<h5[^>]*>/i, close: /<\/h5>$/i },
	h6: { open: /^<h6[^>]*>/i, close: /<\/h6>$/i },
	li: { open: /^<li[^>]*>/i, close: /<\/li>$/i },
	blockquote: { open: /^<blockquote[^>]*>/i, close: /<\/blockquote>$/i },
	figcaption: { open: /^<figcaption[^>]*>/i, close: /<\/figcaption>$/i },
};

// Regex patterns for extracting attributes
const IMG_ALT_PATTERN = /<img[^>]+alt=["']([^"']*)["']/i;
const FIGCAPTION_PATTERN = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i;
const IMG_SRC_PATTERN = /<img[^>]+src=["']([^"']*)["']/i;
const URL_AMP_ENTITY_PATTERN = /&amp;/g;
const URL_NUMERIC_AMP_ENTITY_PATTERN = /&#0?38;/g;
const URL_HEX_AMP_ENTITY_PATTERN = /&#x26;/gi;

type Node = DefaultTreeAdapterMap["node"];
type TextNode = DefaultTreeAdapterMap["textNode"];
type Element = DefaultTreeAdapterMap["element"];

interface ParseResult {
	children: PortableTextSpan[];
	markDefs: PortableTextMarkDef[];
}

/**
 * Parse inline HTML content into Portable Text spans
 */
export function parseInlineContent(html: string, generateKey: () => string): ParseResult {
	const children: PortableTextSpan[] = [];
	const markDefs: PortableTextMarkDef[] = [];
	const markDefMap = new Map<string, string>();

	// Handle whitespace-only input BEFORE stripping (parse5 normalizes whitespace away)
	if (html.length > 0 && !WHITESPACE_PATTERN.test(html)) {
		return {
			children: [{ _type: "span", _key: generateKey(), text: html }],
			markDefs: [],
		};
	}

	// Strip wrapping tags like <p>, <h1>, etc.
	const strippedHtml = stripBlockTags(html);

	// Parse HTML fragment
	const fragment = parseFragment(strippedHtml);

	// Walk the tree and build spans
	walkNodes(fragment.childNodes, children, markDefs, markDefMap, generateKey);

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
 * Strip common block-level wrapper tags
 */
function stripBlockTags(html: string): string {
	// Remove leading/trailing whitespace
	let stripped = html.trim();

	// Strip common block wrappers
	const blockTags = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "figcaption"];

	for (const tag of blockTags) {
		const patterns = BLOCK_TAG_PATTERNS[tag];
		if (patterns && patterns.open.test(stripped) && patterns.close.test(stripped)) {
			stripped = stripped.replace(patterns.open, "").replace(patterns.close, "").trim();
			break;
		}
	}

	return stripped;
}

/**
 * Walk DOM nodes in document order and build spans
 */
function walkNodes(
	nodes: Node[],
	children: PortableTextSpan[],
	markDefs: PortableTextMarkDef[],
	markDefMap: Map<string, string>,
	generateKey: () => string,
): void {
	const pending: PendingNode[] = [];
	pushChildren(pending, nodes, [], undefined);
	for (let entry = pending.pop(); entry; entry = pending.pop()) {
		const { node, marks: currentMarks, link: currentLink } = entry;
		if (isTextNode(node)) {
			const text = node.value;
			if (text) {
				// Handle line breaks in text
				const parts = text.split("\n");
				for (let i = 0; i < parts.length; i++) {
					const part = parts[i];
					if (part || i > 0) {
						// Add text span
						if (part) {
							children.push({
								_type: "span",
								_key: generateKey(),
								text: part,
								marks: currentMarks.length > 0 ? [...currentMarks] : undefined,
							});
						}
						// Add newline (except after last part)
						if (i < parts.length - 1) {
							// Append newline to previous span or create new one
							if (children.length > 0) {
								const lastChild = children.at(-1);
								if (lastChild) {
									lastChild.text += "\n";
								}
							} else {
								children.push({
									_type: "span",
									_key: generateKey(),
									text: "\n",
								});
							}
						}
					}
				}
			}
		} else if (isElement(node)) {
			const tagName = node.tagName.toLowerCase();

			// Handle <br> as newline
			if (tagName === "br") {
				if (children.length > 0) {
					const lastChild = children.at(-1);
					if (lastChild) {
						lastChild.text += "\n";
					}
				} else {
					children.push({
						_type: "span",
						_key: generateKey(),
						text: "\n",
					});
				}
				continue;
			}

			// Get mark for this element
			const markResult = getMarkForElement(node, markDefs, markDefMap, generateKey);
			let newMarks = currentMarks;
			let newLink = currentLink;
			if (markResult && !currentMarks.includes(markResult)) {
				if (tagName === "a") {
					// A span keeps only its innermost link
					newMarks = [...currentMarks.filter((mark) => mark !== currentLink), markResult];
					newLink = markResult;
				} else {
					newMarks = [...currentMarks, markResult];
				}
			}

			pushChildren(pending, node.childNodes, newMarks, newLink);
		}
	}
}

interface PendingNode {
	node: Node;
	marks: string[];
	link: string | undefined;
}

/**
 * Queue nodes so that popping them yields document order
 */
function pushChildren(
	pending: PendingNode[],
	nodes: Node[],
	marks: string[],
	link: string | undefined,
): void {
	for (let i = nodes.length - 1; i >= 0; i--) {
		pending.push({ node: nodes[i]!, marks, link });
	}
}

/**
 * Get the Portable Text mark for an HTML element
 */
function getMarkForElement(
	element: Element,
	markDefs: PortableTextMarkDef[],
	markDefMap: Map<string, string>,
	generateKey: () => string,
): string | null {
	const tagName = element.tagName.toLowerCase();

	switch (tagName) {
		case "strong":
		case "b":
			return "strong";

		case "em":
		case "i":
			return "em";

		case "u":
			return "underline";

		case "s":
		case "strike":
		case "del":
			return "strike-through";

		case "code":
			return "code";

		case "sup":
			return "superscript";

		case "sub":
			return "subscript";

		case "a": {
			const href = sanitizeHref(getAttr(element, "href"));
			const target = getAttr(element, "target");

			// Check if we already have a markDef for this href
			const existingKey = markDefMap.get(href);
			if (existingKey) {
				return existingKey;
			}

			// Create new mark definition
			const key = generateKey();
			const markDef: PortableTextMarkDef = {
				_type: "link",
				_key: key,
				href,
			};
			if (target === "_blank") {
				markDef.blank = true;
			}
			markDefs.push(markDef);
			markDefMap.set(href, key);
			return key;
		}

		default:
			// Unknown inline element - ignore the tag, process children
			return null;
	}
}

/**
 * Get attribute value from element
 */
function getAttr(element: Element, name: string): string | undefined {
	const attr = element.attrs.find((a) => a.name.toLowerCase() === name);
	return attr?.value;
}

/**
 * Type guard for text nodes
 */
function isTextNode(node: Node): node is TextNode {
	return node.nodeName === "#text";
}

/**
 * Type guard for elements
 */
function isElement(node: Node): node is Element {
	return "tagName" in node;
}

/**
 * Extract plain text from HTML (for alt text, captions)
 */
export function extractText(html: string): string {
	const fragment = parseFragment(html);
	return getTextContent(fragment.childNodes);
}

/**
 * Concatenate text content, trimming each element's text as a unit:
 * whitespace is kept only when its innermost element has non-whitespace
 * text both before and after it.
 */
function getTextContent(nodes: Node[]): string {
	let text = "";
	const open: Array<{ nodes: Node[]; index: number; textStart: number }> = [
		{ nodes, index: 0, textStart: 0 },
	];
	// Whitespace awaiting later text in the same element, in document order
	const pendingSpace: Array<{ depth: number; space: string }> = [];

	for (;;) {
		const depth = open.length;
		const current = open[depth - 1]!;
		const node = current.nodes[current.index++];
		if (node === undefined) {
			open.pop();
			while (pendingSpace.at(-1)?.depth === depth) {
				pendingSpace.pop();
			}
			if (open.length === 0) {
				return text;
			}
		} else if (isTextNode(node)) {
			const value = node.value;
			const afterLeading = value.trimStart();
			const body = afterLeading.trimEnd();
			const hasEarlierText = text.length > current.textStart;
			if (!body) {
				if (hasEarlierText && value) {
					pendingSpace.push({ depth, space: value });
				}
				continue;
			}
			for (const pending of pendingSpace) {
				text += pending.space;
			}
			pendingSpace.length = 0;
			if (hasEarlierText) {
				text += value.slice(0, value.length - afterLeading.length);
			}
			text += body;
			const trailing = afterLeading.slice(body.length);
			if (trailing) {
				pendingSpace.push({ depth, space: trailing });
			}
		} else if (isElement(node)) {
			open.push({ nodes: node.childNodes, index: 0, textStart: text.length });
		}
	}
}

/**
 * Extract alt text from an img element in HTML
 */
export function extractAlt(html: string): string | undefined {
	const match = html.match(IMG_ALT_PATTERN);
	if (match) {
		return match[1]; // Can be empty string ""
	}
	return undefined;
}

/**
 * Extract caption from a figcaption element
 */
export function extractCaption(html: string): string | undefined {
	const match = html.match(FIGCAPTION_PATTERN);
	if (match?.[1]) {
		return extractText(match[1]);
	}
	return undefined;
}

/**
 * Extract src from an img element
 */
export function extractSrc(html: string): string | undefined {
	const match = html.match(IMG_SRC_PATTERN);
	if (!match?.[1]) return undefined;
	// Decode HTML entities in URLs
	return decodeUrlEntities(match[1]);
}

/**
 * Decode HTML entities commonly found in URLs
 */
function decodeUrlEntities(url: string): string {
	return url
		.replace(URL_AMP_ENTITY_PATTERN, "&")
		.replace(URL_NUMERIC_AMP_ENTITY_PATTERN, "&")
		.replace(URL_HEX_AMP_ENTITY_PATTERN, "&");
}
