/**
 * URL scheme validation utilities
 *
 * Prevents XSS via dangerous URL schemes (javascript:, data:, vbscript:, etc.)
 * by allowlisting known-safe schemes before rendering into href attributes.
 */

/**
 * Matches URLs that are safe to render in href attributes.
 *
 * Allowed:
 * - http:// and https://
 * - mailto: and tel:
 * - Relative paths (starting with /)
 * - Fragment links (starting with #)
 * - Protocol-relative URLs are NOT allowed (starting with //) as they can
 *   redirect to attacker-controlled hosts.
 */
const SAFE_URL_SCHEME_RE = /^(https?:|mailto:|tel:|\/(?!\/)|#)/i;

/**
 * Returns the URL unchanged if it uses a safe scheme, otherwise returns "#".
 *
 * Use this at the render layer as the primary defense against XSS via
 * dangerous URL schemes like `javascript:`, `data:`, or `vbscript:`.
 *
 * @example
 * ```ts
 * sanitizeHref("https://example.com")        // "https://example.com"
 * sanitizeHref("/about")                      // "/about"
 * sanitizeHref("#section")                    // "#section"
 * sanitizeHref("mailto:a@b.com")              // "mailto:a@b.com"
 * sanitizeHref("javascript:alert(1)")         // "#"
 * sanitizeHref("data:text/html,<script>")     // "#"
 * sanitizeHref("")                            // "#"
 * ```
 */
export function sanitizeHref(url: string | undefined | null): string {
	if (!url) return "#";
	return SAFE_URL_SCHEME_RE.test(url) ? url : "#";
}

/**
 * Returns true if the URL uses a safe scheme for rendering in href attributes.
 */
export function isSafeHref(url: string): boolean {
	return SAFE_URL_SCHEME_RE.test(url);
}

// A backslash after the leading slash is read as "//", making the path protocol-relative.
const RELATIVE_HREF_RE = /^(\/(?![/\\])|#)/;
const HREF_WHITESPACE_RE = /[\t\n\r]/;
const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const ALLOWED_URL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const HREF_STRIPPED_CHARS_RE = /[\t\n\r]/g;

/**
 * Returns true if the value names a URL scheme other than http, https,
 * mailto, or tel, as a browser would resolve it in an href.
 */
export function hasUnsafeUrlScheme(value: string): boolean {
	// Browsers drop tabs and newlines anywhere, and leading control characters and
	// spaces, before resolving an href, so "\tjava\nscript:" still runs script.
	const stripped = value.replace(HREF_STRIPPED_CHARS_RE, "");
	let start = 0;
	while (start < stripped.length && stripped.charCodeAt(start) <= 0x20) start++;
	const scheme = URL_SCHEME_RE.exec(stripped.slice(start))?.[1];
	return scheme !== undefined && !ALLOWED_URL_SCHEMES.has(scheme.toLowerCase());
}

/**
 * Returns true if the value may be stored in a `url` content field: a safe
 * href per {@link isSafeHref} that is either site-relative or a parseable
 * absolute URL.
 */
export function isSafeUrlFieldValue(value: string): boolean {
	if (!isSafeHref(value) || HREF_WHITESPACE_RE.test(value)) return false;
	return RELATIVE_HREF_RE.test(value) || URL.canParse(value);
}
