/**
 * Site settings APIs
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

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
export interface SiteSettingsUpdate extends Omit<
	Partial<SiteSettings>,
	"logo" | "favicon" | "seo"
> {
	logo?: SiteSettings["logo"] | null;
	favicon?: SiteSettings["favicon"] | null;
	seo?: Omit<NonNullable<SiteSettings["seo"]>, "defaultOgImage"> & {
		defaultOgImage?: NonNullable<SiteSettings["seo"]>["defaultOgImage"] | null;
	};
}

/**
 * Fetch site settings
 */
export async function fetchSettings(): Promise<Partial<SiteSettings>> {
	const response = await apiFetch(`${API_BASE}/settings`);
	return parseApiResponse<Partial<SiteSettings>>(response, i18n._(msg`Failed to fetch settings`));
}

/**
 * Update site settings
 */
export async function updateSettings(settings: SiteSettingsUpdate): Promise<Partial<SiteSettings>> {
	const response = await apiFetch(`${API_BASE}/settings`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return parseApiResponse<Partial<SiteSettings>>(response, i18n._(msg`Failed to update settings`));
}

export interface SiteDomain {
	/** Site URL set by the deployment configuration, if any */
	configuredUrl: string | null;
	/** Origin that sign-in handover links to, once a Site URL or `siteUrl` is set */
	siteOrigin: string | null;
}

/**
 * Fetch the configured site URL and the origin sign-in handover links to
 */
export async function fetchSiteDomain(): Promise<SiteDomain> {
	const response = await apiFetch(`${API_BASE}/settings/domain`);
	return parseApiResponse<SiteDomain>(response, i18n._(msg`Failed to fetch the site domain`));
}

/**
 * Create a single-use link that signs the current user in at the site's address
 */
export async function createSignInHandover(): Promise<{ url: string }> {
	const response = await apiFetch(`${API_BASE}/auth/handover`, { method: "POST" });
	return parseApiResponse<{ url: string }>(response, i18n._(msg`Failed to create a sign-in link`));
}

/**
 * Email every other active user a link to the sign-in page at the site's address
 */
export async function notifyUsersOfDomain(): Promise<{ sent: number; failed: number }> {
	const response = await apiFetch(`${API_BASE}/settings/domain/notify`, { method: "POST" });
	return parseApiResponse<{ sent: number; failed: number }>(
		response,
		i18n._(msg`Failed to email users`),
	);
}

/**
 * Check that a domain serves this site, then store it as the Site URL
 */
export async function changeSiteDomain(domain: string): Promise<{ url: string }> {
	const response = await apiFetch(`${API_BASE}/settings/domain`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ domain }),
	});
	return parseApiResponse<{ url: string }>(response, i18n._(msg`Failed to change the domain`));
}
