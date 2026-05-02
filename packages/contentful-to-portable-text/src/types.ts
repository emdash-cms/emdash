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

export interface ConvertOptions {
	/** Hostname used to distinguish internal vs external links */
	blogHostname?: string;
	/**
	 * Custom resolver for entry-hyperlink hrefs. Defaults to `/${slug}/`.
	 * Override for non-blog URL structures (e.g. `/products/${slug}`).
	 */
	entryHrefResolver?: (entry: ContentfulEntry) => string;
}
