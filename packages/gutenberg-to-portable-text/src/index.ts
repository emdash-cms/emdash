/**
 * Gutenberg to Portable Text Converter
 *
 * Converts WordPress Gutenberg block content to Portable Text format.
 * Uses @wordpress/block-serialization-default-parser to parse the hybrid
 * HTML+JSON format that WordPress uses.
 */

import { parse } from "@wordpress/block-serialization-default-parser";

import { parseInlineContent } from "./inline.js";
import { getTransformer } from "./transformers/index.js";
import type {
	GutenbergBlock,
	PortableTextBlock,
	ConvertOptions,
	TransformContext,
} from "./types.js";

// Regex patterns for HTML parsing and conversion
const BLOCK_ELEMENT_PATTERN =
	/<(p|h[1-6]|blockquote|pre|ul|ol|figure|div|hr)[^>]*>([\s\S]*?)<\/\1>|<(hr|br)\s*\/?>|<img\s+[^>]+\/?>/gu;
const LINKED_IMAGE_PATTERN = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*<img\s+([^>]+)\/?>\s*<\/a>/gu;
const STANDALONE_IMAGE_PATTERN = /<img\s+[^>]+\/?>/gu;
const IMG_TAG_PATTERN = /<img[^>]+>/i;
const SRC_ATTR_PATTERN = /src=["']([^"']+)["']/i;
const ALT_ATTR_PATTERN = /alt=["']([^"']*)["']/i;
const LIST_ITEM_PATTERN = /<li[^>]*>([\s\S]*?)<\/li>/gu;
const CODE_TAG_PATTERN = /<code[^>]*>([\s\S]*?)<\/code>/i;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const FIGCAPTION_TAG_PATTERN = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i;
const AMP_ENTITY_PATTERN = /&amp;/g;
const LESS_THAN_ENTITY_PATTERN = /&lt;/g;
const GREATER_THAN_ENTITY_PATTERN = /&gt;/g;
const QUOTE_ENTITY_PATTERN = /&quot;/g;
const APOS_ENTITY_PATTERN = /&#039;/g;
const NUMERIC_AMP_ENTITY_PATTERN = /&#0?38;/g;
const HEX_AMP_ENTITY_PATTERN = /&#x26;/gi;
const NBSP_ENTITY_PATTERN = /&nbsp;/g;

// Re-export types
export type {
	GutenbergBlock,
	PortableTextBlock,
	PortableTextTextBlock,
	PortableTextImageBlock,
	PortableTextCodeBlock,
	PortableTextEmbedBlock,
	PortableTextGalleryBlock,
	PortableTextColumnsBlock,
	PortableTextBreakBlock,
	PortableTextHtmlBlock,
	PortableTextButtonBlock,
	PortableTextButtonsBlock,
	PortableTextCoverBlock,
	PortableTextFileBlock,
	PortableTextPullquoteBlock,
	PortableTextSpan,
	PortableTextMarkDef,
	ConvertOptions,
	BlockTransformer,
	TransformContext,
} from "./types.js";

// Re-export transformers for customization
export { defaultTransformers, fallbackTransformer } from "./transformers/index.js";
export * as coreTransformers from "./transformers/core.js";
export * as embedTransformers from "./transformers/embed.js";

// Re-export inline utilities
export {
	parseInlineContent,
	extractText,
	extractAlt,
	extractCaption,
	extractSrc,
} from "./inline.js";

/**
 * Default key generator
 */
function createKeyGenerator(): () => string {
	let counter = 0;
	return () => {
		counter++;
		return `key-${counter}-${Math.random().toString(36).substring(2, 7)}`;
	};
}

/**
 * Normalize parsed blocks from the WP parser into our GutenbergBlock type.
 * The WP parser returns `attrs: Record<string, any> | null`, so we normalize
 * null attrs to empty objects and recursively process innerBlocks.
 */
function normalizeBlocks(blocks: ReturnType<typeof parse>): GutenbergBlock[] {
	return blocks.map(
		(block): GutenbergBlock => ({
			blockName: block.blockName,
			attrs: (block.attrs ?? {}) satisfies Record<string, unknown>,
			innerHTML: block.innerHTML,
			innerBlocks: normalizeBlocks(block.innerBlocks),
			innerContent: block.innerContent,
		}),
	);
}

/**
 * Convert WordPress Gutenberg content to Portable Text
 *
 * @param content - WordPress post content (HTML with Gutenberg block comments)
 * @param options - Conversion options
 * @returns Array of Portable Text blocks
 *
 * @example
 * ```ts
 * const portableText = gutenbergToPortableText(`
 *   <!-- wp:paragraph -->
 *   <p>Hello <strong>world</strong>!</p>
 *   <!-- /wp:paragraph -->
 * `);
 * // → [{ _type: "block", style: "normal", children: [...] }]
 * ```
 */
export function gutenbergToPortableText(
	content: string,
	options: ConvertOptions = {},
): PortableTextBlock[] {
	// Handle empty content
	if (!content || !content.trim()) {
		return [];
	}

	// Check if content has Gutenberg blocks
	const hasBlocks = content.includes("<!-- wp:");

	if (!hasBlocks) {
		// Classic editor content - treat as HTML
		return htmlToPortableText(content, options);
	}

	// Parse Gutenberg blocks
	const blocks = normalizeBlocks(parse(content));

	// Create key generator
	const generateKey = options.keyGenerator || createKeyGenerator();

	// Create transform context
	const context = createTransformContext(options, generateKey);

	// Transform blocks
	return blocks.flatMap((block) => transformBlock(block, options, context));
}

/**
 * Convert plain HTML (classic editor) to Portable Text
 */
export function htmlToPortableText(
	html: string,
	options: ConvertOptions = {},
): PortableTextBlock[] {
	const generateKey = options.keyGenerator || createKeyGenerator();
	const blocks: PortableTextBlock[] = [];

	// Split on block-level elements (including standalone img tags)
	let lastIndex = 0;
	let match;

	while ((match = BLOCK_ELEMENT_PATTERN.exec(html)) !== null) {
		const fullMatch = match[0];
		const tag = (match[1] || match[3] || "").toLowerCase();
		const content = match[2] || "";

		// Handle text between matches
		const between = html.slice(lastIndex, match.index).trim();
		if (between) {
			const { children, markDefs } = parseInlineContent(between, generateKey);
			if (children.some((c) => c.text.trim())) {
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "normal",
					children,
					markDefs: markDefs.length > 0 ? markDefs : undefined,
				});
			}
		}
		lastIndex = match.index + match[0].length;

		// Check for standalone <img> tag (not wrapped in figure/p)
		if (fullMatch.toLowerCase().startsWith("<img")) {
			const srcMatch = fullMatch.match(SRC_ATTR_PATTERN);
			const altMatch = fullMatch.match(ALT_ATTR_PATTERN);
			if (srcMatch?.[1]) {
				const imgUrl = decodeUrlEntities(srcMatch[1]);
				blocks.push({
					_type: "image",
					_key: generateKey(),
					asset: {
						_type: "reference",
						_ref: imgUrl,
						url: imgUrl,
					},
					alt: altMatch?.[1],
				});
			}
			continue;
		}

		// Transform based on tag
		switch (tag) {
			case "p":
			case "div": {
				// Extract any images first (including those wrapped in <a> tags)
				// Match: <a...><img...></a> or standalone <img...>
				// Track positions of linked images so we don't double-process
				const linkedImgPositions: Array<{ start: number; end: number }> = [];

				// First extract linked images
				let linkedMatch;
				while ((linkedMatch = LINKED_IMAGE_PATTERN.exec(content)) !== null) {
					const linkUrl = decodeUrlEntities(linkedMatch[1]!);
					const imgAttrs = linkedMatch[2]!;
					const srcMatch = imgAttrs.match(SRC_ATTR_PATTERN);
					const altMatch = imgAttrs.match(ALT_ATTR_PATTERN);
					if (srcMatch?.[1]) {
						const imgUrl = decodeUrlEntities(srcMatch[1]);
						blocks.push({
							_type: "image",
							_key: generateKey(),
							asset: {
								_type: "reference",
								_ref: imgUrl,
								url: imgUrl,
							},
							alt: altMatch?.[1],
							link: linkUrl,
						});
					}
					linkedImgPositions.push({
						start: linkedMatch.index,
						end: linkedMatch.index + linkedMatch[0].length,
					});
				}

				// Then extract standalone images (not inside <a> tags)
				let imgMatch;
				while ((imgMatch = STANDALONE_IMAGE_PATTERN.exec(content)) !== null) {
					// Skip if this image is inside a linked image we already processed
					const isLinked = linkedImgPositions.some(
						(pos) => imgMatch!.index >= pos.start && imgMatch!.index < pos.end,
					);
					if (isLinked) continue;

					const srcMatch = imgMatch[0].match(SRC_ATTR_PATTERN);
					const altMatch = imgMatch[0].match(ALT_ATTR_PATTERN);
					if (srcMatch?.[1]) {
						const imgUrl = decodeUrlEntities(srcMatch[1]);
						blocks.push({
							_type: "image",
							_key: generateKey(),
							asset: {
								_type: "reference",
								_ref: imgUrl,
								url: imgUrl,
							},
							alt: altMatch?.[1],
						});
					}
				}

				// Then handle the text content (with images and image links stripped)
				let textContent = content
					.replace(LINKED_IMAGE_PATTERN, "") // Remove linked images
					.replace(STANDALONE_IMAGE_PATTERN, "") // Remove standalone images
					.trim();
				if (textContent) {
					const { children, markDefs } = parseInlineContent(textContent, generateKey);
					if (children.some((c) => c.text.trim())) {
						blocks.push({
							_type: "block",
							_key: generateKey(),
							style: "normal",
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
					}
				}
				break;
			}

			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6": {
				const { children, markDefs } = parseInlineContent(content, generateKey);
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: tag,
					children,
					markDefs: markDefs.length > 0 ? markDefs : undefined,
				});
				break;
			}

			case "blockquote": {
				const { children, markDefs } = parseInlineContent(content, generateKey);
				blocks.push({
					_type: "block",
					_key: generateKey(),
					style: "blockquote",
					children,
					markDefs: markDefs.length > 0 ? markDefs : undefined,
				});
				break;
			}

			case "pre": {
				// Extract code content
				const codeMatch = content.match(CODE_TAG_PATTERN);
				const code = codeMatch?.[1] || content;
				blocks.push({
					_type: "code",
					_key: generateKey(),
					code: decodeHtmlEntities(code),
				});
				break;
			}

			case "ul":
			case "ol": {
				const listItem = tag === "ol" ? "number" : "bullet";
				let liMatch;
				while ((liMatch = LIST_ITEM_PATTERN.exec(content)) !== null) {
					const liContent = liMatch[1] || "";
					const { children, markDefs } = parseInlineContent(liContent, generateKey);
					blocks.push({
						_type: "block",
						_key: generateKey(),
						style: "normal",
						listItem,
						level: 1,
						children,
						markDefs: markDefs.length > 0 ? markDefs : undefined,
					});
				}
				break;
			}

			case "hr": {
				blocks.push({
					_type: "break",
					_key: generateKey(),
					style: "lineBreak",
				});
				break;
			}

			case "figure": {
				// Check for image
				const imgMatch = content.match(IMG_TAG_PATTERN);
				if (imgMatch) {
					const srcMatch = imgMatch[0].match(SRC_ATTR_PATTERN);
					const altMatch = imgMatch[0].match(ALT_ATTR_PATTERN);
					const captionMatch = content.match(FIGCAPTION_TAG_PATTERN);
					const imgUrl = srcMatch?.[1] ? decodeUrlEntities(srcMatch[1]) : "";

					blocks.push({
						_type: "image",
						_key: generateKey(),
						asset: {
							_type: "reference",
							_ref: imgUrl,
							url: imgUrl || undefined,
						},
						alt: altMatch?.[1],
						caption: captionMatch?.[1]?.replace(HTML_TAG_PATTERN, "").trim(),
					});
				}
				break;
			}
		}
	}

	// Handle remaining text
	const remaining = html.slice(lastIndex).trim();
	if (remaining) {
		const { children, markDefs } = parseInlineContent(remaining, generateKey);
		if (children.some((c) => c.text.trim())) {
			blocks.push({
				_type: "block",
				_key: generateKey(),
				style: "normal",
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			});
		}
	}

	return blocks;
}

/**
 * Create transform context for recursive block transformation
 */
function createTransformContext(
	options: ConvertOptions,
	generateKey: () => string,
): TransformContext {
	const context: TransformContext = {
		generateKey,
		parseInlineContent: (html: string) => parseInlineContent(html, generateKey),
		transformBlocks: (blocks: GutenbergBlock[]) =>
			blocks.flatMap((block) => transformBlock(block, options, context)),
	};
	return context;
}

/**
 * Transform a single block
 */
function transformBlock(
	block: GutenbergBlock,
	options: ConvertOptions,
	context: TransformContext,
): PortableTextBlock[] {
	const transformer = getTransformer(block.blockName, options.customTransformers);
	return transformer(block, options, context);
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(html: string): string {
	return html
		.replace(LESS_THAN_ENTITY_PATTERN, "<")
		.replace(GREATER_THAN_ENTITY_PATTERN, ">")
		.replace(AMP_ENTITY_PATTERN, "&")
		.replace(QUOTE_ENTITY_PATTERN, '"')
		.replace(APOS_ENTITY_PATTERN, "'")
		.replace(NUMERIC_AMP_ENTITY_PATTERN, "&") // &#038; or &#38;
		.replace(HEX_AMP_ENTITY_PATTERN, "&") // &#x26;
		.replace(NBSP_ENTITY_PATTERN, " ");
}

/**
 * Decode HTML entities in URLs (used for image src attributes)
 */
function decodeUrlEntities(url: string): string {
	return url
		.replace(AMP_ENTITY_PATTERN, "&")
		.replace(NUMERIC_AMP_ENTITY_PATTERN, "&")
		.replace(HEX_AMP_ENTITY_PATTERN, "&");
}

/**
 * Parse Gutenberg blocks without converting to Portable Text
 * Useful for inspection and debugging
 */
export function parseGutenbergBlocks(content: string): GutenbergBlock[] {
	if (!content || !content.trim()) {
		return [];
	}
	return normalizeBlocks(parse(content));
}
