/** Resolved media reference from getSiteSettings() */
export interface MediaReference {
	mediaId: string;
	alt?: string;
	url?: string;
}

export interface StarterSiteIdentitySettings {
	title?: string;
	tagline?: string;
	logo?: MediaReference;
	favicon?: MediaReference;
	url?: string;
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
}

const DEFAULT_SITE_TITLE = "My Site";
const DEFAULT_SITE_TAGLINE = "Built with EmDash";

export function resolveStarterSiteIdentity(settings?: StarterSiteIdentitySettings) {
	return {
		siteTitle: settings?.title ?? DEFAULT_SITE_TITLE,
		siteTagline: settings?.tagline ?? DEFAULT_SITE_TAGLINE,
		siteLogo: settings?.logo?.url ? settings.logo : null,
		siteFavicon: settings?.favicon?.url ?? null,
		siteUrl: settings?.url?.trim() || null,
		phone: settings?.phone?.trim() || null,
		email: settings?.email?.trim() || null,
		address: settings?.address?.trim() || null,
		locality: settings?.locality?.trim() || null,
		region: settings?.region?.trim() || null,
		postalCode: settings?.postalCode?.trim() || null,
		country: settings?.country?.trim() || null,
		latitude: Number.isFinite(settings?.latitude) ? settings.latitude : null,
		longitude: Number.isFinite(settings?.longitude) ? settings.longitude : null,
		hours: settings?.hours?.trim() || null,
		facebookUrl: settings?.facebookUrl?.trim() || null,
		instagramUrl: settings?.instagramUrl?.trim() || null,
		googleMapsUrl: settings?.googleMapsUrl?.trim() || null,
	};
}
