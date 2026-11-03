import type { RegistryEntryData } from "@emdash-cms/registry-loader";

import { repositoryUrl, safeExternalUrl } from "./registry.js";

/** JSON for an inline `<script type="application/ld+json">`, safe against `</script>` in registry text. */
export function serializeJsonLd(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function pluginJsonLd(
	data: RegistryEntryData,
	url: string,
	options: { image?: string; dateModified?: Date } = {},
) {
	const plugin = data.package;
	const profile = plugin.profile;
	const repository = repositoryUrl(profile);
	return {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: profile?.name || plugin.slug,
		description: profile?.description,
		url,
		image: options.image,
		operatingSystem: "EmDash",
		softwareVersion: data.latestRelease?.release?.version,
		license: profile?.license,
		keywords: profile?.keywords?.join(", ") || undefined,
		dateModified:
			options.dateModified && options.dateModified.valueOf() <= Date.now()
				? options.dateModified.toISOString()
				: undefined,
		author: profile?.authors?.map((author) => ({
			"@type": "Person",
			name: author.name,
			url: safeExternalUrl(author.url),
		})),
		sameAs: repository ? [repository] : undefined,
	};
}
