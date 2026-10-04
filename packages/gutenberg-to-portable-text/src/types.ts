/**
 * Types for Gutenberg to Portable Text conversion
 */

/**
 * Gutenberg block as parsed by @wordpress/block-serialization-default-parser
 */
export interface GutenbergBlock {
	/** Block name like "core/paragraph" or null for freeform HTML */
	blockName: string | null;
	/** Block attributes from the JSON comment */
	attrs: Record<string, unknown>;
	/** Inner HTML content */
	innerHTML: string;
	/** Nested blocks (for columns, groups, etc.) */
	innerBlocks: GutenbergBlock[];
	/** Content parts between inner blocks */
	innerContent: Array<string | null>;
}

/**
 * Portable Text span (inline text with marks)
 */
export interface PortableTextSpan {
	_type: "span";
	_key: string;
	text: string;
	marks?: string[];
}

/**
 * Portable Text mark definition (for links, annotations)
 */
export interface PortableTextMarkDef {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

/**
 * Portable Text text block
 */
export interface PortableTextTextBlock {
	_type: "block";
	_key: string;
	style?: "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote";
	listItem?: "bullet" | "number";
	level?: number;
	children: PortableTextSpan[];
	markDefs?: PortableTextMarkDef[];
}

/**
 * Portable Text image block
 */
export interface PortableTextImageBlock {
	_type: "image";
	_key: string;
	asset: {
		_type: "reference";
		_ref: string;
		url?: string;
	};
	alt?: string;
	caption?: string;
	alignment?: "left" | "center" | "right" | "wide" | "full";
	link?: string | { href: string; blank?: boolean };
}

/**
 * Portable Text code block
 */
export interface PortableTextCodeBlock {
	_type: "code";
	_key: string;
	code: string;
	language?: string;
}

/**
 * Portable Text embed block (YouTube, Twitter, etc.)
 */
export interface PortableTextEmbedBlock {
	_type: "embed";
	_key: string;
	url: string;
	provider?: string;
	html?: string;
}

/**
 * Portable Text gallery block
 */
export interface PortableTextGalleryBlock {
	_type: "gallery";
	_key: string;
	images: Array<{
		_type: "image";
		_key: string;
		asset: { _type: "reference"; _ref: string; url?: string };
		alt?: string;
		caption?: string;
	}>;
	columns?: number;
}

/**
 * Portable Text columns block
 */
export interface PortableTextColumnsBlock {
	_type: "columns";
	_key: string;
	columns: Array<{
		_type: "column";
		_key: string;
		content: PortableTextBlock[];
	}>;
}

/**
 * Portable Text break/divider block
 */
export interface PortableTextBreakBlock {
	_type: "break";
	_key: string;
	style: "lineBreak";
}

/**
 * Portable Text table block
 */
export interface PortableTextTableBlock {
	_type: "table";
	_key: string;
	rows: Array<{
		_type: "tableRow";
		_key: string;
		cells: Array<{
			_type: "tableCell";
			_key: string;
			content: PortableTextSpan[];
			markDefs?: PortableTextMarkDef[];
			isHeader?: boolean;
		}>;
	}>;
	hasHeaderRow?: boolean;
}

/**
 * Fallback HTML block for unconvertible content
 */
export interface PortableTextHtmlBlock {
	_type: "htmlBlock";
	_key: string;
	html: string;
	originalBlockName?: string | null;
	originalAttrs?: Record<string, unknown>;
}

/**
 * Portable Text button block
 */
export interface PortableTextButtonBlock {
	_type: "button";
	_key: string;
	text: string;
	url?: string;
	style?: "default" | "outline" | "fill";
}

/**
 * Portable Text buttons container block
 */
export interface PortableTextButtonsBlock {
	_type: "buttons";
	_key: string;
	buttons: PortableTextButtonBlock[];
	layout?: "horizontal" | "vertical";
}

/**
 * Portable Text cover block (image/video with text overlay)
 */
export interface PortableTextCoverBlock {
	_type: "cover";
	_key: string;
	backgroundImage?: string;
	backgroundVideo?: string;
	overlayColor?: string;
	overlayOpacity?: number;
	content: PortableTextBlock[];
	minHeight?: string;
	alignment?: "left" | "center" | "right";
}

/**
 * Portable Text file download block
 */
export interface PortableTextFileBlock {
	_type: "file";
	_key: string;
	url: string;
	filename?: string;
	showDownloadButton?: boolean;
}

/**
 * Portable Text pullquote block
 */
export interface PortableTextPullquoteBlock {
	_type: "pullquote";
	_key: string;
	text: string;
	citation?: string;
}

/**
 * Union of all Portable Text block types
 */
export type PortableTextBlock =
	| PortableTextTextBlock
	| PortableTextImageBlock
	| PortableTextCodeBlock
	| PortableTextEmbedBlock
	| PortableTextGalleryBlock
	| PortableTextColumnsBlock
	| PortableTextBreakBlock
	| PortableTextTableBlock
	| PortableTextHtmlBlock
	| PortableTextButtonBlock
	| PortableTextButtonsBlock
	| PortableTextCoverBlock
	| PortableTextFileBlock
	| PortableTextPullquoteBlock;

/**
 * Options for the conversion
 */
export interface ConvertOptions {
	/** Map of WordPress media IDs to EmDash media IDs/URLs */
	mediaMap?: Map<number, string>;
	/** Custom block transformers */
	customTransformers?: Record<string, BlockTransformer>;
	/** Whether to generate keys (default: true) */
	generateKeys?: boolean;
	/** Custom key generator */
	keyGenerator?: () => string;
}

/**
 * Block transformer function
 */
export type BlockTransformer = (
	block: GutenbergBlock,
	options: ConvertOptions,
	context: TransformContext,
) => PortableTextBlock[];

/**
 * Context passed to transformers
 */
export interface TransformContext {
	/** Transform child blocks recursively */
	transformBlocks: (blocks: GutenbergBlock[]) => PortableTextBlock[];
	/** Parse inline HTML to spans */
	parseInlineContent: (html: string) => {
		children: PortableTextSpan[];
		markDefs: PortableTextMarkDef[];
	};
	/** Generate a unique key */
	generateKey: () => string;
}

// ── Attribute accessor helpers ──────────────────────────────────────
// Gutenberg attrs are Record<string, unknown>. These narrow safely
// without `as` casts.

/** Extract a string attribute, returning undefined if missing or wrong type */
export function attrString(attrs: Record<string, unknown>, key: string): string | undefined {
	const v = attrs[key];
	return typeof v === "string" ? v : undefined;
}

/** Extract a number attribute, returning undefined if missing or wrong type */
export function attrNumber(attrs: Record<string, unknown>, key: string): number | undefined {
	const v = attrs[key];
	return typeof v === "number" ? v : undefined;
}

/** Extract a boolean attribute, returning undefined if missing or wrong type */
export function attrBoolean(attrs: Record<string, unknown>, key: string): boolean | undefined {
	const v = attrs[key];
	return typeof v === "boolean" ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract an object attribute, returning undefined if missing or wrong type */
export function attrObject(
	attrs: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const v = attrs[key];
	return isRecord(v) ? v : undefined;
}
