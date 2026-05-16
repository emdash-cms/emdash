/**
 * Site settings APIs
 */

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface SiteSettings {
	// Identity
	title: string;
	tagline?: string;
	logo?: { mediaId: string; alt?: string; url?: string };
	favicon?: { mediaId: string; url?: string };

	// URLs
	url?: string;

	// Display
	postsPerPage: number;
	dateFormat: string;
	timezone: string;

	// Social
	social?: {
		twitter?: string;
		github?: string;
		facebook?: string;
		instagram?: string;
		linkedin?: string;
		youtube?: string;
	};

	// SEO
	seo?: {
		titleSeparator?: string;
		defaultOgImage?: { mediaId: string; alt?: string; url?: string };
		robotsTxt?: string;
		googleVerification?: string;
		bingVerification?: string;
	};
}

/**
 * Fetch site settings
 */
export async function fetchSettings(): Promise<Partial<SiteSettings>> {
	const response = await apiFetch(`${API_BASE}/settings`);
	return parseApiResponse<Partial<SiteSettings>>(response, "Failed to fetch settings");
}

/**
 * Update site settings
 */
export async function updateSettings(
	settings: Partial<SiteSettings>,
): Promise<Partial<SiteSettings>> {
	const response = await apiFetch(`${API_BASE}/settings`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return parseApiResponse<Partial<SiteSettings>>(response, "Failed to update settings");
}

// ---------------------------------------------------------------------------
// `emdash:site_url` -- the internal origin used to build links in
// magic-link / invitation / password-reset emails. Separate from
// `SiteSettings.url` (presentation-layer URL used for canonical links).
// See `packages/core/src/astro/routes/api/settings/site-url.ts` and
// upstream issue #989 for why these are distinct.
// ---------------------------------------------------------------------------

export interface SiteUrlSetting {
	siteUrl: string | null;
}

/**
 * Fetch the current `emdash:site_url` option.
 */
export async function fetchSiteUrl(): Promise<SiteUrlSetting> {
	const response = await apiFetch(`${API_BASE}/settings/site-url`);
	return parseApiResponse<SiteUrlSetting>(response, "Failed to fetch site URL");
}

/**
 * Update the `emdash:site_url` option. The value is normalized server-side
 * to a bare origin (e.g. `https://example.com`) before persistence.
 */
export async function updateSiteUrl(siteUrl: string): Promise<SiteUrlSetting> {
	const response = await apiFetch(`${API_BASE}/settings/site-url`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ siteUrl }),
	});
	return parseApiResponse<SiteUrlSetting>(response, "Failed to update site URL");
}
