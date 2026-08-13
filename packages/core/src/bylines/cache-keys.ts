/**
 * Request-cache namespace for `getBylines()` pages.
 *
 * Shared with `BylineRepository`, which drops the whole namespace on every
 * byline write: the keys carry the query's locale, limit, and cursor, so a
 * write path can't name the entries it invalidates.
 */
export const BYLINE_LIST_CACHE_PREFIX = "bylines:";

export function bylineListCacheKey(options: {
	locale?: string | undefined;
	limit?: number | undefined;
	cursor?: string | undefined;
}): string {
	const { locale, limit, cursor } = options;
	return `${BYLINE_LIST_CACHE_PREFIX}${locale ?? "*"}:${limit ?? "*"}:${cursor ?? "*"}`;
}
