/**
 * Build a strict Content-Security-Policy string for EmDash admin/API responses.
 *
 * This helper is intentionally standalone and dependency-free so it can be
 * unit-tested without pulling in Astro runtime virtual modules.
 *
 * @param marketplaceUrl Optional marketplace URL; if valid its origin will be
 *   included in `img-src` to allow marketplace-hosted images.
 * @param storageEndpoint Optional storage adapter endpoint URL; if valid its
 *   origin will be included in both `connect-src` and `img-src` so the admin
 *   UI can upload and display media from S3-like backends.
 * @returns A Content-Security-Policy header value.
 */
export function buildEmDashCsp(marketplaceUrl?: string, storageEndpoint?: string): string {
	const imgSources = ["'self'", "data:", "blob:"];
	const connectSources = ["'self'"];

	if (marketplaceUrl) {
		try {
			imgSources.push(new URL(marketplaceUrl).origin);
		} catch {
			// ignore invalid marketplace URL
		}
	}

	if (storageEndpoint) {
		try {
			const origin = new URL(storageEndpoint).origin;
			connectSources.push(origin);
			imgSources.push(origin);
		} catch {
			// ignore invalid storage endpoint
		}
	}

	return [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		`connect-src ${connectSources.join(" ")}`,
		"form-action 'self'",
		"frame-ancestors 'none'",
		`img-src ${imgSources.join(" ")}`,
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}
