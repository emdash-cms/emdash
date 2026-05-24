/**
 * Site Settings Types
 *
 * Global configuration for the site (title, logo, social links, etc.)
 */

/**
 * Media reference for logo/favicon/seo.defaultOgImage.
 *
 * Stored shape is just `{ mediaId, alt? }`. The remaining fields are
 * populated by `resolveMediaReference` on read so templates can emit
 * correct head tags without a second round-trip to the media table.
 *
 * The Zod schemas at the REST/MCP boundary are split:
 *  - `mediaReferenceInput` (used by `settingsUpdateBody`) defines only
 *    `mediaId` and `alt`. Default strip-mode parsing discards any
 *    resolved fields a client posts back, so they never reach storage.
 *  - `mediaReferenceResponse` (used by `siteSettingsSchema`) includes
 *    the resolved fields so generated OpenAPI clients see them.
 *
 * If you ever switch `mediaReferenceInput` to `passthrough`, you must
 * also strip the resolved fields explicitly in `setSiteSettings`, or
 * stored options will accumulate stale `url` / `contentType` / `width`
 * / `height` snapshots.
 */
export interface MediaReference {
	mediaId: string;
	alt?: string;
	/** Resolved URL. Populated by `resolveMediaReference`; absent on raw stored values. */
	url?: string;
	/** Stored MIME type (e.g. `image/svg+xml`). Populated alongside `url`. */
	contentType?: string;
	/** Pixel width if known. Populated alongside `url`. */
	width?: number;
	/** Pixel height if known. Populated alongside `url`. */
	height?: number;
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
