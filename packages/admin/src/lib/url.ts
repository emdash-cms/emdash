/**
 * Shared URL validation and transformation utilities
 */

const DEFAULT_REDIRECT = "/_emdash/admin";
const LEADING_SLASHES = /^\/+/;

/**
 * Sanitize a redirect URL to prevent open-redirect and javascript: XSS attacks.
 *
 * Only allows relative paths starting with `/`. Rejects protocol-relative
 * URLs (`//evil.com`), backslash tricks (`/\evil.com`), and non-path schemes
 * like `javascript:`.
 *
 * Returns the default admin URL when the input is unsafe.
 */
export function sanitizeRedirectUrl(raw: string): string {
	if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
		return raw;
	}
	return DEFAULT_REDIRECT;
}

/**
 * Build a public content URL from collection metadata and slug.
 *
 * Uses the collection's `urlPattern` when available (e.g. `/blog/{slug}`),
 * otherwise falls back to `/{collection}/{slug}`. Leading slashes are
 * stripped from the slug to prevent protocol-relative URLs.
 */
export function contentUrl(collection: string, slug: string, urlPattern?: string): string {
	const safe = slug.replace(LEADING_SLASHES, "");
	return urlPattern ? urlPattern.replace("{slug}", safe) : `/${collection}/${safe}`;
}

/** Matches http:// or https:// URLs */
export const SAFE_URL_RE = /^https?:\/\//i;

/** Returns true if the URL uses a safe scheme (http/https) */
export function isSafeUrl(url: string): boolean {
	return SAFE_URL_RE.test(url);
}

/**
 * Build an icon URL with a width query param, or return null for unsafe URLs.
 * Validates the URL scheme and appends `?w=<width>` for image resizing.
 */
export function safeIconUrl(url: string, width: number): string | null {
	if (!SAFE_URL_RE.test(url)) return null;
	try {
		const u = new URL(url);
		u.searchParams.set("w", String(width));
		return u.href;
	} catch {
		return null;
	}
}
