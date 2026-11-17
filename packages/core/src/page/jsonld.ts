/**
 * JSON-LD structured data builders
 *
 * Moved from template SEO.astro components into core so all JSON-LD
 * is serialized via safeJsonLdSerialize() and never hand-rolled in templates.
 */

import type { PublicPageContext } from "../plugins/types.js";

/**
 * Remove null/undefined values from a JSON-LD object recursively.
 * JSON-LD validators prefer absent keys over null values.
 */
export function cleanJsonLd(obj: Record<string, unknown>): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined && value !== null) {
			if (typeof value === "object" && !Array.isArray(value)) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- non-null, non-array object is safely treated as Record<string, unknown> for JSON-LD traversal
				cleaned[key] = cleanJsonLd(value as Record<string, unknown>);
			} else {
				cleaned[key] = value;
			}
		}
	}
	return cleaned;
}

/**
 * Site origin to use for JSON-LD node identifiers.
 *
 * `page.siteUrl` wins over `page.url` so IDs stay stable when a theme
 * overrides the public origin. Falls back to the raw canonical or URL only
 * when neither parses as a URL.
 */
function siteOrigin(page: PublicPageContext): string {
	if (page.siteUrl) {
		try {
			return new URL(page.siteUrl).origin;
		} catch {
			return page.siteUrl;
		}
	}
	try {
		return new URL(page.url).origin;
	} catch {
		return page.canonical || page.url;
	}
}

/**
 * Build a BlogPosting JSON-LD graph from page context.
 * Used for article-type content pages.
 *
 * @param page - Page context for the current request.
 * @param defaultOgImage - Optional site-wide fallback image URL, used when
 *   the page has no own OG image. Matches the fallback applied to `og:image`
 *   in `generateBaseSeoContributions`.
 */
export function buildBlogPostingJsonLd(
	page: PublicPageContext,
	defaultOgImage?: string | null,
): Record<string, unknown> | null {
	if (page.pageType !== "article" || !page.canonical) return null;

	const ogTitle = page.seo?.ogTitle ?? page.pageTitle ?? page.title;
	const description = page.seo?.ogDescription || page.description;
	const ogImage = page.seo?.ogImage || page.image || defaultOgImage || null;
	const publishedTime = page.articleMeta?.publishedTime;
	const modifiedTime = page.articleMeta?.modifiedTime;
	const author = page.articleMeta?.author;
	const siteName = page.siteName;

	return cleanJsonLd({
		"@context": "https://schema.org",
		"@type": "BlogPosting",
		"@id": `${page.canonical}#article`,
		headline: ogTitle,
		description,
		image: ogImage || undefined,
		url: page.canonical,
		datePublished: publishedTime || undefined,
		dateModified: modifiedTime || publishedTime || undefined,
		author: author
			? {
					"@type": "Person",
					name: author,
				}
			: undefined,
		publisher: siteName
			? {
					"@type": "Organization",
					"@id": `${siteOrigin(page)}/#organization`,
					name: siteName,
				}
			: undefined,
		mainEntityOfPage: {
			"@type": "WebPage",
			"@id": page.canonical,
		},
	});
}

/**
 * Build a WebSite JSON-LD graph from page context.
 * Used for non-article pages (homepage, listing pages, etc.)
 */
export function buildWebSiteJsonLd(page: PublicPageContext): Record<string, unknown> | null {
	const siteName = page.siteName;
	if (!siteName) return null;

	const siteUrl = siteOrigin(page);

	return cleanJsonLd({
		"@context": "https://schema.org",
		"@type": "WebSite",
		"@id": `${siteUrl}/#website`,
		name: siteName,
		url: siteUrl,
	});
}
