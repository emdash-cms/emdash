/**
 * Contentful blogAuthor → EmDash author collection entry + byline shape.
 */

import type { ContentfulIncludes } from "@emdash-cms/contentful-to-portable-text";

export interface MappedAuthor {
	slug: string;
	locale?: string;
	data: {
		name: string;
		bio?: string | null;
		job_title?: string | null;
		profile_image?: { src: string; alt: string } | null;
	};
}

export function mapAuthor(
	entry: { sys: { id: string; locale?: string }; fields: Record<string, unknown> },
	includes: ContentfulIncludes,
): MappedAuthor {
	// Resolve profile image asset
	const profileImageLink = entry.fields.profileImage as { sys?: { id?: string } } | undefined;
	const assetId = profileImageLink?.sys?.id;
	const asset = assetId ? includes.assets.get(assetId) : undefined;
	let profileImage: { src: string; alt: string } | null = null;
	if (asset?.url) {
		profileImage = {
			src: asset.url.startsWith("//") ? `https:${asset.url}` : asset.url,
			alt: asset.description ?? asset.title ?? "",
		};
	}

	return {
		slug: ((entry.fields.slug as string) ?? "").trim(),
		locale: entry.sys.locale,
		data: {
			name: ((entry.fields.name as string) ?? "").trim(),
			bio: (entry.fields.bio as string) ?? null,
			job_title: (entry.fields.jobTitle as string) ?? null,
			profile_image: profileImage,
		},
	};
}
