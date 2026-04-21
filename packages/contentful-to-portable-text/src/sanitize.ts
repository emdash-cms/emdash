/** Sanitize a URI to prevent javascript: XSS. */
export function sanitizeUri(uri: string): string {
	// Trim and check case-insensitively to catch JaVaScRiPt: etc.
	const normalized = uri.trim();
	if (normalized.toLowerCase().startsWith("javascript:")) return "#";
	return uri;
}
