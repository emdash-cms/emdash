/**
 * Strict Content-Security-Policy for /_emdash routes (admin + API).
 *
 * Applied via middleware header rather than Astro's built-in CSP because
 * Astro's auto-hashing defeats 'unsafe-inline' (CSP3 ignores 'unsafe-inline'
 * when hashes are present), which would break user-facing pages.
 *
 * img-src allows any HTTPS origin because the admin renders user content that
 * may reference external images (migrations, external hosting, embeds).
 * Plugin security does not rely on img-src -- plugins run in V8 isolates with
 * no DOM access, and connect-src 'self' blocks fetch-based exfiltration.
 */
export function buildEmDashCsp(): string {
	return [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		"connect-src 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src 'self' https: data: blob:",
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}
