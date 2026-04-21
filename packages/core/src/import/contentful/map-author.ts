/**
 * Contentful blogAuthor → EmDash author collection entry + byline shape.
 */

import type { ContentfulIncludes } from "@emdash-cms/contentful-to-portable-text";

export interface MappedAuthor {
	slug: string;
	data: {
		name: string;
		bio?: string;
		job_title?: string;
		profile_image?: { src: string; alt: string } | null;
	};
}

export function mapAuthor(
	entry: { sys: { id: string }; fields: Record<string, unknown> },
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
		data: {
			name: ((entry.fields.name as string) ?? "").trim(),
			bio: (entry.fields.bio as string) ?? undefined,
			job_title: (entry.fields.jobTitle as string) ?? undefined,
			profile_image: profileImage,
		},
	};
}
