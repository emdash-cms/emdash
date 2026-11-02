import type { SiteSettings } from "emdash";

const DEFAULT_SITE_TITLE = "My Site";
const DEFAULT_TITLE_SEPARATOR = "—";

/**
 * Site identity from the admin's settings. Cleared values stay cleared: only a
 * missing or blank title falls back, because the header always needs a name.
 */
export function resolveSiteIdentity(settings: Partial<SiteSettings> | undefined) {
	return {
		siteTitle: settings?.title?.trim() || DEFAULT_SITE_TITLE,
		siteTagline: settings?.tagline?.trim() ?? "",
		siteLogo: settings?.logo?.url ? settings.logo : null,
		titleSeparator: settings?.seo?.titleSeparator?.trim() || DEFAULT_TITLE_SEPARATOR,
	};
}
