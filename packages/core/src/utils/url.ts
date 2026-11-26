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
const SAFE_ABSOLUTE_URL_RE = /^(https?:|mailto:|tel:)/i;
const SITE_RELATIVE_HREF_RE = /^(\/(?![/\\])|#)/;
const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const URL_BASE = new URL("https://emdash.invalid/");

function containsHrefControl(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
}

function resolvesOnSite(value: string): boolean {
	try {
		return new URL(value, URL_BASE).origin === URL_BASE.origin;
	} catch {
		return false;
	}
}

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
	return isSafeHref(url) ? url : "#";
}

/**
 * Returns true if the URL uses a safe scheme for rendering in href attributes.
 */
export function isSafeHref(url: string): boolean {
	if (containsHrefControl(url)) return false;
	if (SAFE_ABSOLUTE_URL_RE.test(url)) return URL.canParse(url);
	return SITE_RELATIVE_HREF_RE.test(url) && resolvesOnSite(url);
}

const ALLOWED_URL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Returns true if the value names a URL scheme other than http, https,
 * mailto, or tel, as a browser would resolve it in an href.
 */
export function hasUnsafeUrlScheme(value: string): boolean {
	const stripped = value.replace(/[\t\n\r]/g, "").trimStart();
	const scheme = URL_SCHEME_RE.exec(stripped)?.[1];
	return scheme !== undefined && !ALLOWED_URL_SCHEMES.has(scheme.toLowerCase());
}

/**
 * Returns true when a repository write may keep the value. Repository callers
 * preserve legacy scheme-less values, but reject anything a browser resolves
 * off-site or to a script-capable scheme, and anything that does not read
 * back as the string checked here: a value of another type, or text that
 * looks like JSON, which reads parse into an array or object.
 */
export function isSafeUrlFieldWriteValue(value: unknown): boolean {
	if (typeof value !== "string") return false;
	if (containsHrefControl(value) || hasUnsafeUrlScheme(value)) return false;
	const candidate = value.trimStart();
	if (candidate.startsWith("[") || candidate.startsWith("{")) return false;
	const scheme = URL_SCHEME_RE.exec(candidate)?.[1];
	if (scheme !== undefined) return ALLOWED_URL_SCHEMES.has(scheme.toLowerCase());
	return resolvesOnSite(candidate);
}

/**
 * Returns true if the value may be stored in a `url` content field: a safe
 * href per {@link isSafeHref} that is either site-relative or a parseable
 * absolute URL.
 */
export function isSafeUrlFieldValue(value: string): boolean {
	return isSafeHref(value);
}

const ALLOWED_MEDIA_URL_SCHEMES = new Set(["http", "https"]);

/**
 * Returns true if the value may be stored as a URL of an `image` or `file`
 * value (`src`, `url`, `previewUrl`): an http or https URL, or a value without
 * a scheme, such as a site-relative path or a legacy relative path.
 */
export function isSafeMediaUrl(value: string): boolean {
	if (containsHrefControl(value)) return false;
	const scheme = URL_SCHEME_RE.exec(value.trimStart())?.[1];
	return scheme === undefined || ALLOWED_MEDIA_URL_SCHEMES.has(scheme.toLowerCase());
}
