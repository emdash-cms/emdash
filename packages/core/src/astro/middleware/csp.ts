/**
 * Nonce-based Content-Security-Policy for all HTML responses.
 *
 * Generated per-request by the runtime init middleware and applied to both
 * admin and public pages. Uses cryptographic nonces instead of 'unsafe-inline'
 * for real XSS protection.
 *
 * In dev mode, 'unsafe-inline' is kept alongside the nonce for Vite HMR
 * compatibility. In production, strict nonce-only.
 *
 * img-src allows any HTTPS origin because the admin renders user content that
 * may reference external images (migrations, external hosting, embeds).
 * Plugin security does not rely on img-src -- plugins run in V8 isolates with
 * no DOM access, and connect-src 'self' blocks fetch-based exfiltration.
 */

const B64_PLUS_RE = /\+/g;
const B64_SLASH_RE = /\//g;
const B64_PAD_RE = /=+$/;

/** Generate a per-request CSP nonce using Web Crypto (Workers-compatible). */
export function generateNonce(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	// base64url encoding: replace +/ with -_ and strip padding
	// preserves all 24 chars of base64 output
	return btoa(String.fromCharCode(...bytes))
		.replace(B64_PLUS_RE, "-")
		.replace(B64_SLASH_RE, "_")
		.replace(B64_PAD_RE, "");
}

const SCRIPT_NONCE_RE = /<script(?!\s[^>]*\bnonce=)(?=\s|>)/gi;
const STYLE_NONCE_RE = /<style(?!\s[^>]*\bnonce=)(?=\s|>)/gi;

/**
 * Add nonce attributes to <script> and <style> tags that don't already have one.
 * Idempotent — tags with existing nonce= are left untouched.
 */
export function injectNonceAttributes(html: string, nonce: string): string {
	html = html.replace(SCRIPT_NONCE_RE, `<script nonce="${nonce}"`);
	html = html.replace(STYLE_NONCE_RE, `<style nonce="${nonce}"`);
	return html;
}

export function buildEmDashCsp(nonce: string, dev: boolean): string {
	const scriptSrc = dev ? `'self' 'nonce-${nonce}' 'unsafe-inline'` : `'self' 'nonce-${nonce}'`;
	const styleSrc = dev ? `'self' 'nonce-${nonce}' 'unsafe-inline'` : `'self' 'nonce-${nonce}'`;

	return [
		"default-src 'self'",
		`script-src ${scriptSrc}`,
		`style-src ${styleSrc}`,
		"connect-src 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src 'self' https: data: blob:",
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}
