/**
 * Resolve a stored SEO image reference to a URL.
 *
 * The CMS SEO panel stores `seo_image` in one of these shapes:
 * - an absolute URL (`https://...`) — returned as-is;
 * - a root-relative path that already includes the media API prefix
 *   (`/_emdash/api/media/file/01KS....webp`) — prefixed with `siteUrl`;
 * - a bare media id (`01KS...`) — expanded to the media API path, then
 *   prefixed with `siteUrl`.
 *
 * Shared by the SEO meta builder (`og:image`) and the sitemap route
 * (`<image:image>`) so both resolve image references identically.
 */
const TRAILING_SLASH_RE = /\/$/;
const ABSOLUTE_URL_RE = /^https?:\/\//i;

export function buildSeoImageUrl(imageRef: string, siteUrl?: string): string {
	// Already absolute — use as-is.
	if (ABSOLUTE_URL_RE.test(imageRef)) {
		return imageRef;
	}

	// Root-relative path (already includes the media API prefix). Without
	// this branch we'd re-prefix and produce a doubled path that 404s.
	if (imageRef.startsWith("/")) {
		return siteUrl ? `${siteUrl.replace(TRAILING_SLASH_RE, "")}${imageRef}` : imageRef;
	}

	// Bare media id — build the full media API path.
	const mediaPath = `/_emdash/api/media/file/${imageRef}`;
	return siteUrl ? `${siteUrl.replace(TRAILING_SLASH_RE, "")}${mediaPath}` : mediaPath;
}

/**
 * Resolve a stored SEO canonical value to a URL.
 *
 * The SEO panel accepts absolute URLs, root-relative paths, and bare
 * relative paths. Relative paths are joined with `siteUrl` (adding a
 * leading slash when missing, so we never produce
 * `https://example.composts/x`). Without a `siteUrl` the value is
 * returned as-is. Absolute output matters here: the resolved value feeds
 * `<link rel="canonical">` and `og:url`, both of which search engines and
 * scrapers expect fully qualified.
 */
export function resolveSeoCanonicalUrl(canonical: string, siteUrl?: string): string {
	if (!siteUrl || ABSOLUTE_URL_RE.test(canonical)) {
		return canonical;
	}
	const path = canonical.startsWith("/") ? canonical : `/${canonical}`;
	return `${siteUrl.replace(TRAILING_SLASH_RE, "")}${path}`;
}
