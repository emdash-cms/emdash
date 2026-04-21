/**
 * Site Settings Types
 *
 * Global configuration for the site (title, logo, social links, etc.)
 */

/** Media reference for logo/favicon */
export interface MediaReference {
	mediaId: string;
	alt?: string;
}

/** Site-level SEO settings */
export interface SeoSettings {
	/** Separator between page title and site title (e.g., " | ", " — ") */
	titleSeparator?: string;
	/** Default OG image when content has no seo_image */
	defaultOgImage?: MediaReference;
	/** Custom robots.txt content. If unset, a default is generated. */
	robotsTxt?: string;
	/** Google Search Console verification meta tag content */
	googleVerification?: string;
	/** Bing Webmaster Tools verification meta tag content */
	bingVerification?: string;
}

/** Site settings schema */
export interface SiteSettings {
	// Identity
	title: string;
	tagline?: string;
	logo?: MediaReference;
	favicon?: MediaReference;
	phone?: string;
	email?: string;
	address?: string;
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
	seo?: SeoSettings;
}

/** Keys that are valid site settings */
export type SiteSettingKey = keyof SiteSettings;
