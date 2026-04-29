/** Sanitize a URI to prevent javascript: XSS. */
export function sanitizeUri(uri: string): string {
	// Trim and check case-insensitively to catch JaVaScRiPt: etc.
	const normalized = uri.trim();
	if (normalized.toLowerCase().startsWith("javascript:")) return "#";
	return uri;
const SAFE_URL_SCHEME_RE = /^(https?:|mailto:|tel:|\/(?!\/)|#)/i;

/**
 * Returns the URL unchanged if it uses a safe scheme, otherwise returns "#".
 *
 * Mirrors `sanitizeHref` in `packages/core/src/utils/url.ts` and the sibling
 * gutenberg converter. Allowlist-based so unknown schemes (data:, vbscript:,
 * etc.) are rejected by default, not just `javascript:`.
 */
export function sanitizeUri(uri: string | undefined | null): string {
	if (!uri) return "#";
	const trimmed = uri.trim();
	return SAFE_URL_SCHEME_RE.test(trimmed) ? uri : "#";
}
