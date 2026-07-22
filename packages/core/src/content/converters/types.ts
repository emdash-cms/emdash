/**
 * Portable Text Types
 *
 * Defines the structure of Portable Text blocks used in EmDash.
 */

/**
 * Base span (inline text)
 */
export interface PortableTextSpan {
	_type: "span";
	_key: string;
	text: string;
	marks?: string[];
}

/**
 * Mark definition (bold, italic, link, etc.)
 */
export interface PortableTextMarkDef {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

/**
 * Link mark definition
 */
export interface PortableTextLinkMark extends PortableTextMarkDef {
	_type: "link";
	href: string;
	blank?: boolean;
}

/**
 * Text block (paragraph, heading, etc.)
 */
export interface PortableTextTextBlock {
	_type: "block";
	_key: string;
	style?: "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote";
	listItem?: "bullet" | "number";
	level?: number;
	children: PortableTextSpan[];
	markDefs?: PortableTextMarkDef[];
	textAlign?: "left" | "center" | "right" | "justify";
}

/**
 * Image block
 */
export interface PortableTextImageBlock {
	_type: "image";
	_key: string;
	asset: {
		_ref: string;
		url?: string;
		/** Provider ID for external media (e.g., "cloudflare-images") */
		provider?: string;
	};
	alt?: string;
	caption?: string;
	/** Original image width */
	width?: number;
	/** Original image height */
	height?: number;
	/** Display width for this instance (overrides original) */
	displayWidth?: number;
	/** Display height for this instance (overrides original) */
	displayHeight?: number;
}

/**
 * A single image inside a gallery block. Mirrors the shape produced by
 * gutenberg-to-portable-text and consumed by Gallery.astro.
 */
export interface PortableTextGalleryImage {
	_type: "image";
	_key: string;
	asset: {
		/** Present on WordPress-imported galleries; always emitted on round-trip */
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
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
}

/**
 * Gallery block (grid of images with optional per-image captions)
 */
export interface PortableTextGalleryBlock {
	_type: "gallery";
	_key: string;
	images: PortableTextGalleryImage[];
	columns?: number;
}

/**
 * Code block
 */
export interface PortableTextCodeBlock {
	_type: "code";
	_key: string;
	code: string;
	language?: string;
	filename?: string;
}

/**
 * HTML block (raw HTML content)
 */
export interface PortableTextHtmlBlock {
	_type: "htmlBlock";
	_key: string;
	html: string;
}

/**
 * Unknown/custom block (preserved for plugin compatibility)
 */
export interface PortableTextUnknownBlock {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

/**
 * Any Portable Text block
 */
export type PortableTextBlock =
	| PortableTextTextBlock
	| PortableTextImageBlock
	| PortableTextGalleryBlock
	| PortableTextCodeBlock
	| PortableTextHtmlBlock
	| PortableTextUnknownBlock;

/**
 * ProseMirror JSON types (simplified for TipTap)
 */
export interface ProseMirrorMark {
	type: string;
	attrs?: Record<string, unknown>;
}

export interface ProseMirrorNode {
	type: string;
	attrs?: Record<string, unknown>;
	content?: ProseMirrorNode[];
	marks?: ProseMirrorMark[];
	text?: string;
}

export interface ProseMirrorDocument {
	type: "doc";
	content: ProseMirrorNode[];
}
