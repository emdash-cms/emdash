import type { SiteSettings } from "emdash";

type SocialNetwork = keyof NonNullable<SiteSettings["social"]>;

export interface SocialLink {
	label: string;
	href: string;
}

const NETWORKS: ReadonlyArray<[SocialNetwork, string]> = [
	["twitter", "X (Twitter)"],
	["github", "GitHub"],
	["facebook", "Facebook"],
	["instagram", "Instagram"],
	["linkedin", "LinkedIn"],
	["youtube", "YouTube"],
];

const HTTP_URL = /^https?:\/\//i;
const LEADING_AT = /^@/;
const YOUTUBE_CHANNEL_ID = /^UC[\w-]{22}$/;

function profileUrl(network: SocialNetwork, value: string): string | null {
	const raw = value.trim();
	if (HTTP_URL.test(raw)) return raw;
	const handle = raw.replace(LEADING_AT, "");
	if (!handle) return null;
	const path = encodeURIComponent(handle);
	switch (network) {
		case "twitter":
			return `https://x.com/${path}`;
		case "github":
			return `https://github.com/${path}`;
		case "facebook":
			return `https://www.facebook.com/${path}`;
		case "instagram":
			return `https://www.instagram.com/${path}`;
		case "linkedin":
			return `https://www.linkedin.com/in/${path}`;
		case "youtube":
			return !raw.startsWith("@") && YOUTUBE_CHANNEL_ID.test(handle)
				? `https://www.youtube.com/channel/${path}`
				: `https://www.youtube.com/@${path}`;
	}
}

/**
 * Profile links for the social accounts in site settings, in a fixed
 * order. Settings hold handles ("@studio" or "studio"); a value that is
 * already an http(s) URL is used as it is.
 */
export function getSocialLinks(social: SiteSettings["social"]): SocialLink[] {
	return NETWORKS.flatMap(([network, label]) => {
		const value = social?.[network];
		const href = value ? profileUrl(network, value) : null;
		return href ? [{ label, href }] : [];
	});
}
