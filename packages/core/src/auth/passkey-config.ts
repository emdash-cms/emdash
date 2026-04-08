/**
 * Passkey configuration helper
 *
 * Extracts passkey configuration from the request URL.
 * This ensures the rpId and origin are correctly set for both
 * localhost development and production deployments.
 */

export interface PasskeyConfig {
	rpName: string;
	rpId: string;
	origin: string;
}

/**
 * Get passkey configuration from request URL
 *
 * @param url The request URL (typically `new URL(Astro.request.url)` or `new URL(request.url)`)
 * @param siteName Optional site name for rpName (defaults to hostname from `url` or public origin)
 * @param siteUrl Optional browser-facing origin (see `EmDashConfig.siteUrl`).
 *        When set, **origin** and **rpId** are taken from this URL so they match WebAuthn `clientData.origin`.
 * @throws If `siteUrl` is non-empty but not parseable by `new URL()`.
 */
export function getPasskeyConfig(url: URL, siteName?: string, siteUrl?: string): PasskeyConfig {
	if (siteUrl) {
		let publicUrl: URL;
		try {
			publicUrl = new URL(siteUrl);
		} catch (e) {
			throw new Error(`Invalid siteUrl: "${siteUrl}"`, { cause: e });
		}
		return {
			rpName: siteName || publicUrl.hostname,
			rpId: publicUrl.hostname,
			origin: publicUrl.origin,
		};
	}

	return {
		rpName: siteName || url.hostname,
		rpId: url.hostname,
		origin: url.origin,
	};
}
