/**
 * Generate base SEO metadata contributions from PublicPageContext.
 *
 * These contributions are prepended BEFORE plugin contributions in
 * resolvePageMetadata(), which uses first-wins dedup. This means
 * plugins can override any base SEO tag by contributing the same key.
 *
 * This replaces the per-template SEO.astro components, eliminating
 * the class of XSS bugs where templates hand-rolled JSON-LD serialization.
 */

import type { PageMetadataContribution, PublicPageContext } from "../plugins/types.js";
import { buildBlogPostingJsonLd, buildWebSiteJsonLd } from "./jsonld.js";

/**
 * Generate base metadata contributions from a page context's SEO data.
 * Returns an empty array if no SEO-relevant data is present.
 */
export function generateBaseSeoContributions(page: PublicPageContext): PageMetadataContribution[] {
	const contributions: PageMetadataContribution[] = [];

	const description = page.description;
	const ogTitle = page.seo?.ogTitle ?? page.pageTitle ?? page.title;
	const ogDescription = page.seo?.ogDescription || description;
	const ogImage = page.seo?.ogImage || page.image;
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
		const blogPosting = buildBlogPostingJsonLd(page);
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
