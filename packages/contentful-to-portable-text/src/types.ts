/** Contentful Rich Text document */
export interface ContentfulDocument {
	nodeType: "document";
	content: ContentfulNode[];
	data: Record<string, unknown>;
}

export interface ContentfulNode {
	nodeType: string;
	content?: ContentfulNode[];
	value?: string;
	marks?: Array<{ type: string }>;
	data: Record<string, unknown>;
}

/** Resolved includes from a Contentful response */
export interface ContentfulIncludes {
	entries: Map<string, ContentfulEntry>;
	assets: Map<string, ContentfulAsset>;
}

export interface ContentfulEntry {
	id: string;
	contentType: string;
	fields: Record<string, unknown>;
}

export interface ContentfulAsset {
	id: string;
	title?: string;
	description?: string;
	url: string;
	width?: number;
	height?: number;
	contentType?: string;
}

/** Portable Text block (output) */
export interface PTBlock {
	_type: string;
	_key: string;
	[key: string]: unknown;
}

export interface PTSpan {
	_type: "span";
	_key: string;
	text: string;
	marks: string[];
}

export interface PTMarkDef {
	_key: string;
	_type: string;
	[key: string]: unknown;
}

/** Options for the converter */
export interface ConvertOptions {
	/** Blog hostname for internal/external link detection */
	blogHostname?: string;
}
