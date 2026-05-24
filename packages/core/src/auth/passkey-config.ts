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
	/**
	 * Accepted client-data origins. First entry is the canonical/preferred origin;
	 * additional entries support multi-origin deployments (e.g. apex + preview
	 * subdomain sharing the same `rpId`). See `allowedOrigins` parameter.
	 */
	origins: string[];
}

/**
 * Get passkey configuration from request URL
 *
 * @param url The request URL (typically `new URL(Astro.request.url)` or `new URL(request.url)`)
 * @param siteName Optional site name for rpName (defaults to hostname from `url` or public origin)
 * @param siteUrl Optional browser-facing origin (see `EmDashConfig.siteUrl`).
 *        When set, the canonical **origin** and **rpId** are taken from this URL.
 * @param allowedOrigins Optional list of additional accepted origins for verification.
 *        Each must share `rpId` with the canonical origin (WebAuthn requirement).
 *        Typical use: apex + preview subdomain on the same registrable domain.
 * @throws If `siteUrl` is non-empty but not parseable by `new URL()`.
 */
export function getPasskeyConfig(
	url: URL,
	siteName?: string,
	siteUrl?: string,
	allowedOrigins?: string[],
): PasskeyConfig {
	let rpName: string;
	let rpId: string;
	let canonicalOrigin: string;

	if (siteUrl) {
		let publicUrl: URL;
		try {
			publicUrl = new URL(siteUrl);
		} catch (e) {
			throw new Error(`Invalid siteUrl: "${siteUrl}"`, { cause: e });
		}
		rpName = siteName || publicUrl.hostname;
		rpId = publicUrl.hostname;
		canonicalOrigin = publicUrl.origin;
	} else {
		rpName = siteName || url.hostname;
		rpId = url.hostname;
		canonicalOrigin = url.origin;
	}

	const origins = [canonicalOrigin];
	if (allowedOrigins) {
		for (const extra of allowedOrigins) {
			if (extra && !origins.includes(extra)) origins.push(extra);
		}
	}

	return { rpName, rpId, origins };
}
