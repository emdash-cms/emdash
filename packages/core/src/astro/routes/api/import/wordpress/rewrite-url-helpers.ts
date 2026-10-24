const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const WORDPRESS_IMAGE_SIZE_SUFFIX = /-\d+x\d+(?=\.[^./?#]+$)/;
const BASE_URL_EXTENSION = /^(.+)(\.[^./?#]+)$/;
const QUERY_BEFORE_FRAGMENT = /^[^#]*\?/;
/** What may follow a URL in a string field: its end, a quote, a tag, or the punctuation of prose. */
const URL_END = `(?=$|["'\\s<>)\\],;:!?]|\\.(?=$|["'\\s<>)\\]]))`;

/**
 * Strip query parameters from a URL for base matching
 */
export function getBaseUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		// If URL parsing fails, try simple string split
		return url.split("?")[0] || url;
	}
}

/**
 * Whether a URL map key carries a query string, which makes it one URL rather
 * than a file: `https://example.com/?attachment_id=7` is an attachment's page,
 * and its base is the home page. Such a key is matched exactly, never by its
 * base, or every link to the home page would be rewritten with it.
 */
export function carriesQuery(url: string): boolean {
	return QUERY_BEFORE_FRAGMENT.test(url);
}

/**
 * Build a map of base URLs to new URLs for flexible matching. A key that
 * carries a query has no base entry (see `carriesQuery`).
 */
export function buildBaseUrlMap(urlMap: Record<string, string>): Map<string, string> {
	const baseMap = new Map<string, string>();
	for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
		if (carriesQuery(oldUrl)) continue;
		const baseUrl = getBaseUrl(oldUrl);
		baseMap.set(baseUrl, newUrl);
	}
	return baseMap;
}

/**
 * Extract the URL to match from a stored media field value.
 *
 * Image/file columns hold a JSON-stringified MediaValue
 * (e.g. `{"provider":"external","id":"","src":"https://.../hero.jpg"}`), but legacy
 * rows may hold a bare URL string. Returns the inner `src` for a MediaValue, otherwise
 * the value unchanged. Without this, the whole JSON blob is passed to findMatchingUrl()
 * and the embedded URL is never matched.
 */
export function extractMediaUrl(value: string): string {
	try {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- shape validated below
		const parsed = JSON.parse(value) as { src?: unknown };
		if (parsed && typeof parsed.src === "string") {
			return parsed.src;
		}
	} catch {
		// Not JSON — treat the column value as a bare URL.
	}
	return value;
}

/**
 * Find matching new URL for a given URL, checking exact, base, and WordPress image-size matches
 */
export function findMatchingUrl(
	url: string,
	exactMap: Record<string, string>,
	baseMap: Map<string, string>,
): string | null {
	if (exactMap[url]) {
		return exactMap[url];
	}

	const baseUrl = getBaseUrl(url);
	const baseMatch = baseMap.get(baseUrl);
	if (baseMatch) {
		return baseMatch;
	}

	const wordPressImageMatch = baseMap.get(stripWordPressImageSizeSuffix(baseUrl));
	if (wordPressImageMatch) {
		return wordPressImageMatch;
	}

	return null;
}

/**
 * Portable Text block type (simplified for URL rewriting)
 */
export interface PortableTextBlock {
	_type: string;
	_key?: string;
	asset?: {
		_type?: string;
		_ref?: string;
		url?: string;
	};
	/** Linked-image target: legacy string, or `{ href, blank? }` from the editor */
	link?: string | { href?: string; blank?: boolean };
	// For nested content like galleries
	images?: PortableTextBlock[];
	columns?: Array<{ content?: PortableTextBlock[] }>;
	content?: PortableTextBlock[];
	markDefs?: Array<Record<string, unknown>>;
	rows?: Array<{ cells?: Array<{ markDefs?: Array<Record<string, unknown>> }> }>;
	buttons?: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

/**
 * Rewrite URLs in a Portable Text array, returning whether any changes were made
 */
export function rewritePortableTextUrls(
	blocks: PortableTextBlock[],
	exactMap: Record<string, string>,
	baseMap: Map<string, string>,
): { changed: boolean; urlsRewritten: number } {
	let changed = false;
	let urlsRewritten = 0;

	const rewriteField = (target: Record<string, unknown>, key: string): boolean => {
		const value = target[key];
		const newUrl = typeof value === "string" ? findMatchingUrl(value, exactMap, baseMap) : null;
		if (!newUrl) return false;
		target[key] = newUrl;
		changed = true;
		urlsRewritten++;
		return true;
	};
	const rewriteHtml = (target: Record<string, unknown>, count = true) => {
		if (typeof target.html !== "string") return;
		const result = rewriteStringUrls(target.html, exactMap, baseMap);
		if (result.changed) {
			target.html = result.newValue;
			changed = true;
			if (count) urlsRewritten += result.urlsRewritten;
		}
	};
	const rewriteMarkDefs = (markDefs: Array<Record<string, unknown>> | undefined) => {
		for (const def of markDefs ?? []) rewriteField(def, "href");
	};
	const rewriteNested = (content: PortableTextBlock[] | undefined) => {
		if (!Array.isArray(content)) return;
		const result = rewritePortableTextUrls(content, exactMap, baseMap);
		if (result.changed) {
			changed = true;
			urlsRewritten += result.urlsRewritten;
		}
	};

	for (const block of blocks) {
		switch (block._type) {
			case "image":
				if (block.asset?.url) {
					const newUrl = findMatchingUrl(block.asset.url, exactMap, baseMap);
					if (newUrl) {
						block.asset.url = newUrl;
						block.asset._ref = newUrl; // Also update the reference
						changed = true;
						urlsRewritten++;
					}
				}
				// The link is a bare string on freshly imported content and
				// `{ href, blank? }` once edited in the editor.
				if (typeof block.link === "string") {
					rewriteField(block, "link");
				} else if (block.link) {
					rewriteField(block.link, "href");
				}
				break;
			case "gallery":
				rewriteNested(block.images);
				break;
			case "columns":
				for (const column of block.columns ?? []) rewriteNested(column.content);
				break;
			case "cover":
				rewriteField(block, "backgroundImage");
				rewriteNested(block.content);
				break;
			case "block":
				rewriteMarkDefs(block.markDefs);
				break;
			case "table":
				for (const row of block.rows ?? []) {
					for (const cell of row.cells ?? []) rewriteMarkDefs(cell.markDefs);
				}
				break;
			case "file":
			case "button":
				rewriteField(block, "url");
				break;
			case "embed":
				// The html carries the same media URL; count it only when the url didn't match
				rewriteHtml(block, !rewriteField(block, "url"));
				break;
			case "htmlBlock":
				rewriteHtml(block);
				break;
			case "buttons":
				for (const button of block.buttons ?? []) rewriteField(button, "url");
				break;
		}
	}

	return { changed, urlsRewritten };
}

/**
 * Rewrite URLs in a string field using simple string replacement
 */
export function rewriteStringUrls(
	value: string,
	exactMap: Record<string, string>,
	baseMap: Map<string, string>,
): { newValue: string; changed: boolean; urlsRewritten: number } {
	let newValue = value;
	let changed = false;
	let urlsRewritten = 0;

	// Try exact matches first. A key that carries a query is replaced only where
	// the URL ends with it: `?attachment_id=7` is not the start of `?attachment_id=71`.
	for (const [oldUrl, newUrl] of Object.entries(exactMap)) {
		if (!newValue.includes(oldUrl)) continue;
		const replaced = carriesQuery(oldUrl)
			? newValue.replace(new RegExp(`${escapeRegExp(oldUrl)}${URL_END}`, "g"), () => newUrl)
			: newValue.split(oldUrl).join(newUrl);
		if (replaced === newValue) continue;
		newValue = replaced;
		changed = true;
		urlsRewritten++;
	}

	// For base URL matching in strings, we need to be more careful
	// Only match if we find a URL that starts with the base
	for (const [baseUrl, newUrl] of baseMap.entries()) {
		// Look for the base URL followed by optional query string or end
		const regex = buildBaseUrlMatchRegex(baseUrl);
		const matches = newValue.match(regex);
		if (matches) {
			for (const match of matches) {
				// Don't replace if we already have an exact match in the map
				if (!exactMap[match]) {
					newValue = newValue.split(match).join(newUrl);
					changed = true;
					urlsRewritten++;
				}
			}
		}
	}

	return { newValue, changed, urlsRewritten };
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
	return string.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

function stripWordPressImageSizeSuffix(url: string): string {
	return url.replace(WORDPRESS_IMAGE_SIZE_SUFFIX, "");
}

function buildBaseUrlMatchRegex(baseUrl: string): RegExp {
	const extensionMatch = BASE_URL_EXTENSION.exec(baseUrl);
	const basePattern = extensionMatch
		? `${escapeRegExp(extensionMatch[1])}(?:-\\d+x\\d+)?${escapeRegExp(extensionMatch[2])}`
		: escapeRegExp(baseUrl);

	return new RegExp(`${basePattern}(\\?[^"'\\s]*)?${URL_END}`, "g");
}
