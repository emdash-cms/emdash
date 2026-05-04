const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const WORDPRESS_IMAGE_SIZE_SUFFIX = /-\d+x\d+(?=\.[^./?#]+$)/;
const BASE_URL_EXTENSION = /^(.+)(\.[^./?#]+)$/;

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
 * Build a map of base URLs to new URLs for flexible matching
 */
export function buildBaseUrlMap(urlMap: Record<string, string>): Map<string, string> {
	const baseMap = new Map<string, string>();
	for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
		const baseUrl = getBaseUrl(oldUrl);
		baseMap.set(baseUrl, newUrl);
	}
	return baseMap;
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
interface PortableTextBlock {
	_type: string;
	_key?: string;
	asset?: {
		_type?: string;
		_ref?: string;
		url?: string;
	};
	link?: string;
	// For nested content like galleries
	images?: PortableTextBlock[];
	columns?: Array<{ content?: PortableTextBlock[] }>;
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

	for (const block of blocks) {
		// Handle image blocks
		if (block._type === "image" && block.asset?.url) {
			const newUrl = findMatchingUrl(block.asset.url, exactMap, baseMap);
			if (newUrl) {
				block.asset.url = newUrl;
				block.asset._ref = newUrl; // Also update the reference
				changed = true;
				urlsRewritten++;
			}
		}

		// Handle image link URLs (for linked images)
		if (block._type === "image" && block.link) {
			const newUrl = findMatchingUrl(block.link, exactMap, baseMap);
			if (newUrl) {
				block.link = newUrl;
				changed = true;
				urlsRewritten++;
			}
		}

		// Handle gallery blocks with nested images
		if (block._type === "gallery" && Array.isArray(block.images)) {
			const result = rewritePortableTextUrls(block.images, exactMap, baseMap);
			if (result.changed) {
				changed = true;
				urlsRewritten += result.urlsRewritten;
			}
		}

		// Handle columns blocks with nested content
		if (block._type === "columns" && Array.isArray(block.columns)) {
			for (const column of block.columns) {
				if (Array.isArray(column.content)) {
					const result = rewritePortableTextUrls(column.content, exactMap, baseMap);
					if (result.changed) {
						changed = true;
						urlsRewritten += result.urlsRewritten;
					}
				}
			}
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

	// Try exact matches first
	for (const [oldUrl, newUrl] of Object.entries(exactMap)) {
		if (newValue.includes(oldUrl)) {
			newValue = newValue.split(oldUrl).join(newUrl);
			changed = true;
			urlsRewritten++;
		}
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

	return new RegExp(
		`${basePattern}(\\?[^"'\\s]*)?(?=$|["'\\s<>)\\],;:!?]|\\.(?=$|["'\\s<>)\\]]))`,
		"g",
	);
}
