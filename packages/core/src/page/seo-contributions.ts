/**
 * Generate base SEO metadata contributions from PublicPageContext.
 *
 * EmDashHead.astro composes the final contribution list as
 * `[...plugin, ...site, ...base]` and feeds it to `resolvePageMetadata()`,
 * which is first-wins. That ordering means plugin contributions override
 * site-level ones override base ones for any given key — base values are
 * the fallback, not the source of truth. For content pages, the entry's
 * SEO panel values are overlaid onto the page context before the base
 * contributions (and JSON-LD) are generated, so editor-set values
 * override the template-provided fields.
 *
 * This replaces the per-template SEO.astro components, eliminating
 * the class of XSS bugs where templates hand-rolled JSON-LD serialization.
 */

import type { ContentSeo } from "../database/repositories/types.js";
import type { PageMetadataContribution, PublicPageContext } from "../plugins/types.js";
import { buildSeoImageUrl, resolveSeoCanonicalUrl } from "../seo/media-url.js";
import type { SeoSettings } from "../settings/types.js";
import { buildBlogPostingJsonLd, buildWebSiteJsonLd } from "./jsonld.js";

/**
 * Generate base metadata contributions from a page context's SEO data.
 *
 * @param page - Page context produced by the runtime for the current request.
 * @param defaultOgImage - Optional site-wide fallback OG image URL, used when
 *   the page has no own OG image (i.e., neither `seo.ogImage` nor `image`).
 *   Sourced from `SiteSettings.seo.defaultOgImage` by `EmDashHead`.
 *
 * Returns an empty array if no SEO-relevant data is present.
 */
export function generateBaseSeoContributions(
	page: PublicPageContext,
	defaultOgImage?: string | null,
): PageMetadataContribution[] {
	const contributions: PageMetadataContribution[] = [];

	const description = page.description;
	const ogTitle = page.seo?.ogTitle ?? page.pageTitle ?? page.title;
	const ogDescription = page.seo?.ogDescription || description;
	const ogImage = page.seo?.ogImage || page.image || defaultOgImage || null;
	const robots = page.seo?.robots;
	const canonical = page.canonical;
	const siteName = page.siteName;

	// -- Meta tags --

	if (description) {
		contributions.push({ kind: "meta", name: "description", content: description });
	}

	if (robots) {
		contributions.push({ kind: "meta", name: "robots", content: robots });
	}

	// -- Canonical link --

	if (canonical) {
		contributions.push({ kind: "link", rel: "canonical", href: canonical });
	}

	// -- Open Graph --

	contributions.push({
		kind: "property",
		property: "og:type",
		content: page.pageType === "article" ? "article" : "website",
	});

	if (ogTitle) {
		contributions.push({ kind: "property", property: "og:title", content: ogTitle });
	}

	if (ogDescription) {
		contributions.push({ kind: "property", property: "og:description", content: ogDescription });
	}

	if (ogImage) {
		contributions.push({ kind: "property", property: "og:image", content: ogImage });
	}

	if (canonical) {
		contributions.push({ kind: "property", property: "og:url", content: canonical });
	}

	if (siteName) {
		contributions.push({ kind: "property", property: "og:site_name", content: siteName });
	}

	// -- Twitter Card --

	contributions.push({
		kind: "meta",
		name: "twitter:card",
		content: ogImage ? "summary_large_image" : "summary",
	});

	if (ogTitle) {
		contributions.push({ kind: "meta", name: "twitter:title", content: ogTitle });
	}

	if (ogDescription) {
		contributions.push({ kind: "meta", name: "twitter:description", content: ogDescription });
	}

	if (ogImage) {
		contributions.push({ kind: "meta", name: "twitter:image", content: ogImage });
	}

	// -- Article metadata --

	if (page.pageType === "article" && page.articleMeta) {
		const { publishedTime, modifiedTime, author } = page.articleMeta;
		if (publishedTime) {
			contributions.push({
				kind: "property",
				property: "article:published_time",
				content: publishedTime,
			});
		}
		if (modifiedTime) {
			contributions.push({
				kind: "property",
				property: "article:modified_time",
				content: modifiedTime,
			});
		}
		if (author) {
			contributions.push({
				kind: "property",
				property: "article:author",
				content: author,
			});
		}
	}

	// -- JSON-LD --

	if (page.pageType === "article") {
		const blogPosting = buildBlogPostingJsonLd(page, defaultOgImage ?? null);
		if (blogPosting) {
			contributions.push({ kind: "jsonld", id: "primary", graph: blogPosting });
		}
	} else if (siteName) {
		const webSite = buildWebSiteJsonLd(page);
		if (webSite) {
			contributions.push({ kind: "jsonld", id: "primary", graph: webSite });
		}
	}

	return contributions;
}

/**
 * Overlay a content entry's SEO panel data onto the page context (#1518).
 *
 * `EmDashHead` fetches the entry's `_emdash_seo` row when the page context
 * references a content entry and applies this overlay before anything
 * consumes the context: editor-set panel values override whatever the
 * template passed in, and because the overlaid context feeds plugin hooks,
 * the base contributions, and the JSON-LD builders alike, structured data
 * and head tags always agree. Plugins still override the rendered output
 * via first-wins dedup.
 *
 * The `<title>` element itself stays the template's responsibility —
 * head components can't replace it — so `seo.title` feeds
 * `og:title` / `twitter:title` / the JSON-LD headline only. Templates that
 * want the panel title in `<title>` keep using `getSeoMeta()`.
 *
 * Unset panel fields fall back to the template-provided values, so pages
 * without SEO data are unaffected.
 */
export function applySeoPanelToPageContext(
	page: PublicPageContext,
	seo: ContentSeo,
	options: { siteUrl?: string | null } = {},
): PublicPageContext {
	const siteUrl = options.siteUrl ?? undefined;
	const image = seo.image ? buildSeoImageUrl(seo.image, siteUrl) : null;
	const canonical = seo.canonical ? resolveSeoCanonicalUrl(seo.canonical, siteUrl) : null;

	return {
		...page,
		description: seo.description || page.description,
		canonical: canonical || page.canonical,
		seo: {
			...page.seo,
			ogTitle: seo.title || page.seo?.ogTitle,
			ogDescription: seo.description || page.seo?.ogDescription,
			ogImage: image || page.seo?.ogImage,
			robots: seo.noIndex ? "noindex, nofollow" : page.seo?.robots,
		},
	};
}

/**
 * Generate site-level SEO metadata contributions from SiteSettings.seo.
 *
 * These tags apply to every page (search engine ownership verification),
 * so they're sourced from site settings rather than per-page context.
 * Returns an empty array when no relevant settings are configured.
 */
export function generateSiteSeoContributions(
	seoSettings: SeoSettings | undefined,
): PageMetadataContribution[] {
	const contributions: PageMetadataContribution[] = [];

	if (!seoSettings) {
		return contributions;
	}

	if (seoSettings.googleVerification) {
		contributions.push({
			kind: "meta",
			name: "google-site-verification",
			content: seoSettings.googleVerification,
		});
	}

	if (seoSettings.bingVerification) {
		contributions.push({
			kind: "meta",
			name: "msvalidate.01",
			content: seoSettings.bingVerification,
		});
	}

	return contributions;
}
