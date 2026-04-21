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
	phone?: string;
	email?: string;
	address?: string;
	locality?: string;
	region?: string;
	postalCode?: string;
	country?: string;
	latitude?: number;
	longitude?: number;
	hours?: string;
	facebookUrl?: string;
	instagramUrl?: string;
	googleMapsUrl?: string;

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
