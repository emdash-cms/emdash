export interface StarterSiteIdentitySettings {
	title?: string;
	tagline?: string;
}

const DEFAULT_SITE_TITLE = "My Site";
const DEFAULT_SITE_TAGLINE = "Built with EmDash";

export function resolveStarterSiteIdentity(settings?: StarterSiteIdentitySettings) {
	return {
		siteTitle: settings?.title ?? DEFAULT_SITE_TITLE,
		siteTagline: settings?.tagline ?? DEFAULT_SITE_TAGLINE,
	};
}
