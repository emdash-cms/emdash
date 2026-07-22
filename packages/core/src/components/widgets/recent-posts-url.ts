/**
 * Build a post link URL from a template, replacing the `:slug` token.
 * Extracted from RecentPosts.astro so it's unit-testable without a DB-backed
 * render harness. Mirrors the `:slug` token style used by
 * `buildLiveSearchResultUrl` (see live-search-routing.ts) for consistency.
 *
 * Uses split/join rather than `String.replace` — `replace`'s second
 * argument treats `$&`/`$1`-style sequences in `slug` as special
 * replacement patterns, which would corrupt the URL for a pathological slug.
 */
export function buildRecentPostUrl(slug: string, urlTemplate: string): string {
	return urlTemplate.split(":slug").join(slug);
}
