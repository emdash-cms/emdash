/**
 * URL scheme allowlist matching packages/core/src/utils/url.ts and
 * gutenberg-to-portable-text/src/url.ts. Rejects javascript:, data:,
 * vbscript:, protocol-relative URLs, and any other unexpected scheme.
 */
const SAFE_URL_SCHEME_RE = /^(https?:|mailto:|tel:|\/(?!\/)|#)/i;

/** Returns the URL unchanged if safe, otherwise "#". */
export function sanitizeUri(uri: string): string {
	if (!uri) return "#";
	const trimmed = uri.trim();
	return SAFE_URL_SCHEME_RE.test(trimmed) ? trimmed : "#";
}
