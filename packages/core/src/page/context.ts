/**
 * Public page context builder
 *
 * Templates call this to describe the page being rendered.
 * The resulting context is passed to EmDashHead / EmDashBodyStart / EmDashBodyEnd.
 */

import type { PublicPageContext } from "../plugins/types.js";

/** Fields shared by both input forms */
interface PageContextFields {
	kind: "content" | "custom";
	pageType?: string;
	title?: string | null;
	description?: string | null;
	canonical?: string | null;
	image?: string | null;
	content?: { collection: string; id: string; slug?: string | null };
	/** SEO overrides for OG/Twitter meta generation */
	seo?: {
		ogTitle?: string | null;
		ogDescription?: string | null;
		ogImage?: string | null;
		robots?: string | null;
	};
	/** Article metadata for Open Graph article: tags */
	articleMeta?: {
		publishedTime?: string | null;
		modifiedTime?: string | null;
		author?: string | null;
	};
	/** Site name for structured data and og:site_name */
	siteName?: string;
	/** Public-facing site URL (origin) for structured data */
	siteUrl?: string;
}

/** Input with Astro global -- used in .astro files */
interface AstroInput extends PageContextFields {
	Astro: { url: URL; currentLocale?: string };
}

/** Input with explicit URL -- used outside .astro files */
interface UrlInput extends PageContextFields {
	url: URL | string;
	locale?: string;
}

export type CreatePublicPageContextInput = AstroInput | UrlInput;

function isAstroInput(input: CreatePublicPageContextInput): input is AstroInput {
	return "Astro" in input;
}

/**
 * Build a PublicPageContext from template input.
 */
export function createPublicPageContext(input: CreatePublicPageContextInput): PublicPageContext {
	let url: string;
	let path: string;
	let locale: string | null;

	if (isAstroInput(input)) {
		url = input.Astro.url.href;
		path = input.Astro.url.pathname;
		locale = input.Astro.currentLocale ?? null;
	} else {
		const parsed = typeof input.url === "string" ? new URL(input.url) : input.url;
		url = parsed.href;
		path = parsed.pathname;
		locale = input.locale ?? null;
	}

	return {
		url,
		path,
		locale,
		kind: input.kind,
		pageType: input.pageType ?? (input.kind === "content" ? "article" : "website"),
		title: input.title ?? null,
		description: input.description ?? null,
		canonical: input.canonical ?? null,
		image: input.image ?? null,
		content: input.content
			? {
					collection: input.content.collection,
					id: input.content.id,
					slug: input.content.slug ?? null,
				}
			: undefined,
		seo: input.seo,
		articleMeta: input.articleMeta,
		siteName: input.siteName,
		siteUrl: input.siteUrl,
	};
}
