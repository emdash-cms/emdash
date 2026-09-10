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
 * The site's public origin, as the graphs below refer to it.
 *
 * Lifted out of `buildWebSiteJsonLd` unchanged, because `buildBlogPostingJsonLd`
 * now needs the same answer and two copies of this chain would eventually
 * disagree — which, for values used to build an `@id`, means silently
 * publishing two entities instead of one.
 *
 * Deliberately NOT `resolveSiteOrigin()` from `absolute-url.ts`: that gives
 * `SiteSettings.url` precedence over `page.siteUrl`, which would change which
 * origin these graphs carry. That may well be the better order, but it is a
 * behaviour change and does not belong in a fix about node identity.
 */
function siteOrigin(page: PublicPageContext): string {
	if (page.siteUrl) return page.siteUrl;
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
		// A fragment, not the bare canonical: `mainEntityOfPage` below already
		// identifies the WebPage by that IRI, and reusing it would state that the
		// article and the page it sits on are the same thing.
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
		// Identified, but still self-describing. `@id` lets a fuller Organization
		// graph — from a plugin, or hand-written in a template — merge into this
		// node instead of standing beside it as a second, competing organisation.
		// `@type` and `name` stay so that a site publishing no such graph is left
		// with a complete node rather than a dangling reference.
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
		// So a plugin can add `potentialAction` (a sitelinks SearchAction, say)
		// by emitting a node under the same `@id`, rather than a second WebSite.
		"@id": `${siteUrl}#website`,
		name: siteName,
		url: siteUrl,
	});
}
