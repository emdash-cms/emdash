/**
 * SEO Helpers
 *
 * Public API functions for generating SEO meta tags in Astro templates.
 *
 * @example
 * ```astro
 * ---
 * import { getEmDashEntry } from "emdash";
 * import { getSeoMeta } from "emdash/seo";
 *
 * const post = await getEmDashEntry("posts", Astro.params.slug);
 * const meta = await getSeoMeta(post, {
 *   siteTitle: "My Blog",
 *   siteUrl: Astro.url.origin,
 * });
 * ---
 * <html>
 *   <head>
 *     <title>{meta.title}</title>
 *     <meta name="description" content={meta.description} />
 *     <meta property="og:title" content={meta.ogTitle} />
 *     <meta property="og:description" content={meta.ogDescription} />
 *     {meta.ogImage && <meta property="og:image" content={meta.ogImage} />}
 *     <link rel="canonical" href={meta.canonical} />
 *     {meta.robots && <meta name="robots" content={meta.robots} />}
 *   </head>
 * </html>
 * ```
 */

import type { ContentSeo } from "../database/repositories/types.js";

const TRAILING_SLASH_RE = /\/$/;
const ABSOLUTE_URL_RE = /^https?:\/\//i;

/**
 * Content input for SEO functions.
 * Accepts both ContentEntry<T> (from query functions) and ContentItem (internal).
 */
export interface SeoContentInput<T = Record<string, unknown>> {
	/** Content data object */
	data: T & {
		title?: unknown;
		excerpt?: unknown;
		seo?: ContentSeo;
	};
	/** SEO metadata (legacy location, prefer data.seo) */
	seo?: ContentSeo;
}

/** Resolved SEO meta tags ready for use in templates */
export interface SeoMeta {
	/** Full <title> tag content (e.g., "Post Title | Site Name") */
	title: string;
	/** Meta description */
	description: string | null;
	/** OG title (same as title by default) */
	ogTitle: string;
	/** OG description */
	ogDescription: string | null;
	/** OG image URL (absolute) */
	ogImage: string | null;
	/** Canonical URL */
	canonical: string | null;
	/** Robots directive (e.g., "noindex, nofollow") or null if default */
	robots: string | null;
}

/** Options for generating SEO meta from a content item */
export interface SeoMetaOptions {
	/** Site title for the suffix (e.g., "My Blog") */
	siteTitle?: string;
	/** Site URL origin for building absolute URLs (e.g., "https://example.com") */
	siteUrl?: string;
	/** Title separator between page title and site title */
	titleSeparator?: string;
	/** Path to this content (e.g., "/posts/my-post") for canonical fallback */
	path?: string;
	/** Default OG image URL if content has none */
	defaultOgImage?: string;
}

/**
 * Generate resolved SEO meta tags from a content item.
 *
 * Uses the content item's SEO fields, falling back to content data
 * (title from `data.title`, description from `data.excerpt`).
 *
 * @param content - The content item (from getEmDashEntry, etc.)
 * @param options - Configuration for title construction, canonical URLs, etc.
 * @returns Resolved meta tags ready for template use
 */
export function getSeoMeta<T>(content: SeoContentInput<T>, options: SeoMetaOptions = {}): SeoMeta {
	const { siteTitle, siteUrl, path, defaultOgImage } = options;
	const separator = options.titleSeparator || " | ";
	// SEO can be in content.seo (ContentItem) or content.data.seo (ContentEntry)
	const seo = content.seo ??
		content.data.seo ?? {
			title: null,
			description: null,
			image: null,
			canonical: null,
			noIndex: false,
		};

	// Title: SEO title > content title > fallback
	const pageTitle =
		seo.title || (typeof content.data.title === "string" ? content.data.title : null) || "";

	const fullTitle = siteTitle && pageTitle ? `${pageTitle}${separator}${siteTitle}` : pageTitle;

	// Description: SEO description > excerpt
	const description =
		seo.description ||
		(typeof content.data.excerpt === "string" ? content.data.excerpt : null) ||
		null;

	// OG image: SEO image > default
	const ogImage = seo.image ? buildMediaUrl(seo.image, siteUrl) : (defaultOgImage ?? null);

	// Canonical: explicit > path-based > null
	let canonical: string | null = null;
	if (seo.canonical) {
		// Ensure relative canonical paths get a leading slash so we don't
		// produce "https://example.composts/x" when joined with siteUrl
		if (siteUrl && !seo.canonical.startsWith("/") && !ABSOLUTE_URL_RE.test(seo.canonical)) {
			canonical = `${siteUrl.replace(TRAILING_SLASH_RE, "")}/${seo.canonical}`;
		} else {
			canonical = seo.canonical;
		}
	} else if (siteUrl && path) {
		const safePath = path.startsWith("/") ? path : `/${path}`;
		canonical = `${siteUrl.replace(TRAILING_SLASH_RE, "")}${safePath}`;
	}

	// Robots
	const robots = seo.noIndex ? "noindex, nofollow" : null;

	return {
		title: fullTitle,
		description,
		ogTitle: pageTitle || fullTitle,
		ogDescription: description,
		ogImage,
		canonical,
		robots,
	};
}

/**
 * Extract SEO data from a content item.
 *
 * Convenience accessor for the raw SEO fields without template resolution.
 *
 * @param content - The content item
 * @returns The content's SEO fields
 */
export function getContentSeo<T>(content: SeoContentInput<T>): ContentSeo | undefined {
	return content.seo ?? content.data.seo;
}

/**
 * Build a media URL from a media reference ID.
 * If it's already an absolute URL, return as-is.
 */
function buildMediaUrl(imageRef: string, siteUrl?: string): string {
	// If already an absolute URL, return as-is
	if (ABSOLUTE_URL_RE.test(imageRef)) {
		return imageRef;
	}

	// Root-relative path — the CMS SEO panel stores seo_image as
	// "/_emdash/api/media/file/01KS....svg" (already includes the API
	// prefix). Without this branch we'd re-prefix and produce
	// "${siteUrl}/_emdash/api/media/file//_emdash/api/media/file/<id>"
	// which 404s and breaks <meta property="og:image">.
	if (imageRef.startsWith("/")) {
		return siteUrl
			? `${siteUrl.replace(TRAILING_SLASH_RE, "")}${imageRef}`
			: imageRef;
	}

	// Bare media_id — build the full media API path
	const mediaPath = `/_emdash/api/media/file/${imageRef}`;
	if (siteUrl) {
		return `${siteUrl.replace(TRAILING_SLASH_RE, "")}${mediaPath}`;
	}
	return mediaPath;
}
