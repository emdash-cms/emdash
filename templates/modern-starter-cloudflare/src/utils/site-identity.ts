/** Resolved media reference from getSiteSettings() */
export interface MediaReference {
	mediaId: string;
	alt?: string;
	url?: string;
}

export interface ModernStarterSiteIdentitySettings {
	title?: string;
	tagline?: string;
	logo?: MediaReference;
	favicon?: MediaReference;
}

const DEFAULT_SITE_TITLE = "Modern Starter";
const DEFAULT_SITE_TAGLINE = "A premium dark editorial template for EmDash.";

export function resolveModernStarterSiteIdentity(
	settings?: ModernStarterSiteIdentitySettings,
) {
	return {
		siteTitle: settings?.title ?? DEFAULT_SITE_TITLE,
		siteTagline: settings?.tagline ?? DEFAULT_SITE_TAGLINE,
		siteLogo: settings?.logo?.url ? settings.logo : null,
		siteFavicon: settings?.favicon?.url ?? null,
	};
}
