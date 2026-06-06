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

// ── Runtime shapes for Contentful payloads ───────────────────────────────────
//
// `@contentful/rich-text-types` types `node.data` loosely (effectively
// `Record<string, any>`) because the shape of `data.target`, `data.uri`, and
// related fields depends on the runtime resolution of includes. The guards
// below validate the runtime shapes we read so the rest of the converter
// can rely on typed values without scattered casts at every read site.

/**
 * Contentful link payload (`data.target` on embedded entry/asset nodes,
 * and on entry/asset hyperlink inlines). Resolved against the includes
 * map via `sys.id`.
 */
export interface ContentfulLinkPayload {
	sys: { id: string };
}

/**
 * Contentful entry/asset envelope (top-level item in an export's
 * `Entry` / `Asset` arrays). The `sys.contentType.sys.id` chain is only
 * present on entries.
 */
export interface ContentfulSysEnvelope {
	sys: { id: string; contentType?: { sys: { id: string } } };
	fields?: Record<string, unknown>;
}

/**
 * Contentful asset `fields.file` shape, defined by the Contentful
 * Delivery API. All members optional because legacy/draft assets may
 * omit any of them.
 */
export interface ContentfulAssetFile {
	url?: string;
	contentType?: string;
	details?: {
		image?: {
			width?: number;
			height?: number;
		};
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard for the `{ sys: { id: string } }` link payload Contentful
 * uses for embedded entries, embedded assets, and entry/asset hyperlinks.
 */
export function isContentfulLinkPayload(value: unknown): value is ContentfulLinkPayload {
	if (!isObject(value)) return false;
	const sys = value.sys;
	if (!isObject(sys)) return false;
	return typeof sys.id === "string";
}

/**
 * Type guard for a top-level Contentful entry/asset envelope from an
 * export's `Entry` / `Asset` arrays. Requires `sys.id`; `contentType`
 * and `fields` are validated only as far as needed for the converter.
 */
export function isContentfulSysEnvelope(value: unknown): value is ContentfulSysEnvelope {
	if (!isObject(value)) return false;
	const sys = value.sys;
	if (!isObject(sys)) return false;
	if (typeof sys.id !== "string") return false;
	if (sys.contentType !== undefined) {
		if (!isObject(sys.contentType)) return false;
		const ctSys = sys.contentType.sys;
		if (!isObject(ctSys) || typeof ctSys.id !== "string") return false;
	}
	if (value.fields !== undefined && !isObject(value.fields)) return false;
	return true;
}

/**
 * Narrow `fields[key]` to `string | undefined`. Non-strings are treated
 * as missing — the converter never wants to surface a non-string field
 * as text.
 */
export function getStringField(
	fields: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = fields?.[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Narrow `fields[key]` to a record (object). Used for nested field
 * shapes like `fields.file` on assets, or the `data.target` link
 * payload.
 */
export function getRecordField(
	fields: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	const value = fields?.[key];
	return isObject(value) ? value : undefined;
}

/**
 * Parse a Contentful asset `fields.file` value into the typed shape.
 * Returns `undefined` when the value is missing or not an object;
 * individual fields are validated and dropped if of the wrong type.
 */
export function parseAssetFile(value: unknown): ContentfulAssetFile | undefined {
	if (!isObject(value)) return undefined;
	const file: ContentfulAssetFile = {};
	if (typeof value.url === "string") file.url = value.url;
	if (typeof value.contentType === "string") file.contentType = value.contentType;
	if (isObject(value.details)) {
		const image = isObject(value.details.image) ? value.details.image : undefined;
		if (image) {
			file.details = {
				image: {
					width: typeof image.width === "number" ? image.width : undefined,
					height: typeof image.height === "number" ? image.height : undefined,
				},
			};
		}
	}
	return file;
}
