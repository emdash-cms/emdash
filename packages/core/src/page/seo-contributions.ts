/**
 * Generate base SEO metadata contributions from PublicPageContext.
 *
 * EmDashHead.astro composes the final contribution list as
 * `[...plugin, ...site, ...panel, ...base]` and feeds it to
 * `resolvePageMetadata()`, which is first-wins. That ordering means plugin
 * contributions override site-level ones override SEO-panel values override
 * base ones for any given key — base values are the fallback, not the
 * source of truth.
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
 * Generate metadata contributions from a content entry's SEO panel data (#1518).
 *
 * `EmDashHead` fetches the entry's `_emdash_seo` row when the page context
 * references a content entry and inserts these contributions between the
 * plugin and base layers: editor-set panel values override whatever the
 * template passed into the page context (via first-wins dedup), while
 * plugins can still override everything.
 *
 * The `<title>` element itself stays the template's responsibility —
 * head components can't replace it — so `seo.title` is emitted for
 * `og:title` / `twitter:title` only. Templates that want the panel title
 * in `<title>` keep using `getSeoMeta()`.
 *
 * Returns an empty array when no panel field is set, so pages without
 * SEO data are unaffected.
 */
export function generateSeoPanelContributions(
	seo: ContentSeo,
	options: { siteUrl?: string | null } = {},
): PageMetadataContribution[] {
	const contributions: PageMetadataContribution[] = [];
	const siteUrl = options.siteUrl ?? undefined;

	if (seo.title) {
		contributions.push({ kind: "property", property: "og:title", content: seo.title });
		contributions.push({ kind: "meta", name: "twitter:title", content: seo.title });
	}

	if (seo.description) {
		contributions.push({ kind: "meta", name: "description", content: seo.description });
		contributions.push({
			kind: "property",
			property: "og:description",
			content: seo.description,
		});
		contributions.push({ kind: "meta", name: "twitter:description", content: seo.description });
	}

	if (seo.image) {
		const image = buildSeoImageUrl(seo.image, siteUrl);
		contributions.push({ kind: "property", property: "og:image", content: image });
		contributions.push({ kind: "meta", name: "twitter:image", content: image });
		// The base layer only picks the large-image card when it has an image
		// of its own; with a panel image the large card must win too.
		contributions.push({ kind: "meta", name: "twitter:card", content: "summary_large_image" });
	}

	if (seo.canonical) {
		const canonical = resolveSeoCanonicalUrl(seo.canonical, siteUrl);
		contributions.push({ kind: "link", rel: "canonical", href: canonical });
		contributions.push({ kind: "property", property: "og:url", content: canonical });
	}

	if (seo.noIndex) {
		contributions.push({ kind: "meta", name: "robots", content: "noindex, nofollow" });
	}

	return contributions;
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
