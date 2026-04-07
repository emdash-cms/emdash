/**
 * Strict Content-Security-Policy for /_emdash routes (admin + API).
 *
 * Applied via middleware header rather than Astro's built-in CSP because
 * Astro's auto-hashing defeats 'unsafe-inline' (CSP3 ignores 'unsafe-inline'
 * when hashes are present), which would break user-facing pages.
 */
export function buildEmDashCsp(marketplaceUrl?: string): string {
	const imgSources = ["'self'", "https:", "data:", "blob:"];
	if (marketplaceUrl) {
		try {
			imgSources.push(new URL(marketplaceUrl).origin);
		} catch {
			// ignore invalid marketplace URL
		}
	}
	return [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		"connect-src 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		`img-src ${imgSources.join(" ")}`,
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}
