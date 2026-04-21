/**
 * Contentful blogPost → shape for handleContentCreate.
 *
 * Converts rich text content to Portable Text via the converter package,
 * resolves feature images, tags, authors, and locale lists from the
 * includes map.
 */

import {
	richTextToPortableText,
	type ContentfulIncludes,
	type ContentfulDocument,
} from "@emdash-cms/contentful-to-portable-text";

import { flattenLocaleList } from "./map-locale-list.js";

export interface MappedPost {
	slug: string;
	locale?: string;
	data: Record<string, unknown>;
	seo?: {
		description?: string;
		noIndex?: boolean;
	};
	/** Contentful publishDate or sys.createdAt — used as publishedAt */
	publishDate?: string;
	/** Contentful sys.createdAt — used as createdAt */
	createdAt?: string;
	/** Tag slugs referenced by this post */
	tagSlugs: string[];
	/** Author slugs referenced by this post */
	authorSlugs: string[];
}

export function mapPost(
	entry: {
		sys: { id: string; createdAt: string };
		fields: Record<string, unknown>;
	},
	includes: ContentfulIncludes,
	options: { blogHostname?: string } = {},
): MappedPost {
	const fields = entry.fields;

	// Convert rich text content → Portable Text
	const content = fields.content
		? richTextToPortableText(fields.content as ContentfulDocument, includes, {
				blogHostname: options.blogHostname,
			})
		: [];

	// Resolve feature image
	const featureImageLink = fields.featureImage as { sys?: { id?: string } } | undefined;
	const featureAssetId = featureImageLink?.sys?.id;
	const featureAsset = featureAssetId ? includes.assets.get(featureAssetId) : undefined;
	let featuredImage: { src: string; alt: string } | undefined;
	if (featureAsset?.url) {
		featuredImage = {
			src: featureAsset.url.startsWith("//") ? `https:${featureAsset.url}` : featureAsset.url,
			alt: featureAsset.description ?? featureAsset.title ?? "",
		};
	}

	// Resolve tag slugs from entry links
	// Handle both "tags" and "tag" field names
	const tagLinks = (fields.tags ?? fields.tag ?? []) as Array<{
		sys: { id: string };
	}>;
	const tagSlugs: string[] = [];
	for (const link of tagLinks) {
		const tagEntry = includes.entries.get(link.sys.id);
		if (tagEntry?.fields?.slug) {
			tagSlugs.push((tagEntry.fields.slug as string).trim());
		}
	}

	// Resolve author slugs from entry links
	// Handle both "authors" and "author" field names
	const authorLinks = (fields.authors ?? fields.author ?? []) as Array<{
		sys: { id: string };
	}>;
	const authorSlugs: string[] = [];
	for (const link of authorLinks) {
		const authorEntry = includes.entries.get(link.sys.id);
		if (authorEntry?.fields?.slug) {
			authorSlugs.push((authorEntry.fields.slug as string).trim());
		}
	}

	// Resolve locale_list from configLocaleList entry link
	let localeList: Record<string, string> | undefined;
	const localeListLink = fields.localeList as { sys?: { id?: string } } | undefined;
	const localeListId = localeListLink?.sys?.id;
	if (localeListId) {
		const localeListEntry = includes.entries.get(localeListId);
		if (localeListEntry?.fields) {
			localeList = flattenLocaleList(localeListEntry.fields);
		}
	}

	// Build SEO
	let seo: MappedPost["seo"];
	const metaDescription = fields.metaDescription as string | undefined;
	const publiclyIndex = fields.publiclyIndex as boolean | undefined;
	if (metaDescription || publiclyIndex === false) {
		seo = {};
		if (metaDescription) seo.description = metaDescription;
		if (publiclyIndex === false) seo.noIndex = true;
	}

	const data: Record<string, unknown> = {
		title: ((fields.title as string) ?? "").trim(),
		excerpt: (fields.excerpt as string) ?? undefined,
		content,
	};

	// Only include optional fields when they have values.
	// These may or may not exist in the target collection schema --
	// handleContentCreate will ignore columns that don't exist in the table,
	// but SQLite errors if we try to INSERT into a non-existent column.
	if (featuredImage) {
		data.featured_image = featuredImage;
	}
	if (fields.featured != null) {
		data.featured = fields.featured as boolean;
	}
	if (localeList) {
		data.locale_list = localeList;
	}

	return {
		slug: ((fields.slug as string) ?? "").trim(),
		data,
		seo,
		publishDate: (fields.publishDate as string) ?? entry.sys.createdAt,
		createdAt: entry.sys.createdAt,
		tagSlugs,
		authorSlugs,
	};
}
