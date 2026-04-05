import type { SeedContentEntry, SeedRedirect, SeedTaxonomy } from "../../seed/types.js";
import type { GhostExportData, GhostPost } from "./parser.js";
import {
	buildGhostPostMetaByPostId,
	buildGhostTagSlugsByPostId,
	sortGhostPostsByPublishedDate,
} from "./parser.js";
import {
	buildGhostExcerpt,
	normalizeGhostMediaUrl,
	rewriteGhostHtml,
	stripGhostHtml,
} from "./rewrite.js";

export interface GhostToSeedConfig {
	mediaBaseUrl?: string;
	siteBaseUrl?: string;
	excludedPageSlugs?: string[];
	postCollection?: string;
	pageCollection?: string;
	tagTaxonomyName?: string;
	postRoutePrefix?: string;
	subscribePath?: string;
	staticRedirects?: SeedRedirect[];
}

export interface GhostSeedFragment {
	taxonomies?: SeedTaxonomy[];
	content: Record<string, SeedContentEntry[]>;
	redirects: SeedRedirect[];
}

const DEFAULT_POST_COLLECTION = "posts";
const DEFAULT_PAGE_COLLECTION = "pages";
const DEFAULT_TAG_TAXONOMY = "tags";
const DEFAULT_POST_ROUTE_PREFIX = "/blog";
const TRAILING_SLASHES_PATTERN = /\/+$/;

function mapGhostStatus(status: string | null | undefined): "published" | "draft" {
	return status === "published" ? "published" : "draft";
}

function buildSourcePath(post: GhostPost): string {
	return `/${post.slug}/`;
}

function buildPostRedirect(slug: string, routePrefix: string): SeedRedirect {
	return {
		source: `/${slug}/`,
		destination: `${routePrefix}/${slug}/`,
		type: 301,
		enabled: true,
	};
}

function uniqueRedirects(redirects: SeedRedirect[]): SeedRedirect[] {
	const seen = new Set<string>();
	const result: SeedRedirect[] = [];

	for (const redirect of redirects) {
		const key = `${redirect.source}->${redirect.destination}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(redirect);
	}

	return result;
}

export function buildGhostSeedFragment(
	data: GhostExportData,
	config: GhostToSeedConfig = {},
): GhostSeedFragment {
	const postCollection = config.postCollection ?? DEFAULT_POST_COLLECTION;
	const pageCollection = config.pageCollection ?? DEFAULT_PAGE_COLLECTION;
	const tagTaxonomyName = config.tagTaxonomyName ?? DEFAULT_TAG_TAXONOMY;
	const postRoutePrefix = (config.postRoutePrefix ?? DEFAULT_POST_ROUTE_PREFIX).replace(
		TRAILING_SLASHES_PATTERN,
		"",
	);
	const excludedPageSlugs = new Set(config.excludedPageSlugs ?? []);
	const tagSlugsByPostId = buildGhostTagSlugsByPostId(data);
	const postMetaByPostId = buildGhostPostMetaByPostId(data);
	const sortedPosts = sortGhostPostsByPublishedDate(data.posts);
	const postSlugs = new Set(
		sortedPosts.filter((post) => post.type === "post" && post.slug).map((post) => post.slug),
	);

	const content: Record<string, SeedContentEntry[]> = {
		[postCollection]: [],
		[pageCollection]: [],
	};

	for (const post of sortedPosts) {
		if (!post.slug) {
			continue;
		}

		if (post.type === "page" && excludedPageSlugs.has(post.slug)) {
			continue;
		}

		const rewrittenHtml = rewriteGhostHtml(post.html ?? "", {
			siteBaseUrl: config.siteBaseUrl,
			mediaBaseUrl: config.mediaBaseUrl,
			postSlugs,
			postRoutePrefix,
			subscribePath: config.subscribePath,
		});
		const summary = buildGhostExcerpt(post, rewrittenHtml);
		const meta = postMetaByPostId.get(post.id);
		const featuredImageUrl = normalizeGhostMediaUrl(post.feature_image, config.mediaBaseUrl);
		const bodyText = String(post.plaintext || stripGhostHtml(rewrittenHtml)).trim();
		const seedEntry: SeedContentEntry = {
			id: `ghost-${post.id}`,
			slug: post.slug,
			status: mapGhostStatus(post.status),
			createdAt: post.created_at ?? undefined,
			updatedAt: post.updated_at ?? undefined,
			publishedAt: post.published_at ?? undefined,
			data:
				post.type === "page"
					? {
							title: post.title ?? post.slug,
							description: summary,
							body_html: rewrittenHtml,
							body_text: bodyText,
							featured_image_url: featuredImageUrl,
							feature_image_alt: meta?.feature_image_alt ?? undefined,
							feature_image_caption: meta?.feature_image_caption ?? undefined,
							visibility: post.visibility ?? "public",
						}
					: {
							title: post.title ?? post.slug,
							excerpt: summary,
							body_html: rewrittenHtml,
							body_text: bodyText,
							featured_image_url: featuredImageUrl,
							feature_image_alt: meta?.feature_image_alt ?? undefined,
							feature_image_caption: meta?.feature_image_caption ?? undefined,
							visibility: post.visibility ?? "public",
							source_path: buildSourcePath(post),
						},
		};

		if (post.type === "page") {
			content[pageCollection].push(seedEntry);
		} else if (post.type === "post") {
			seedEntry.taxonomies = { [tagTaxonomyName]: tagSlugsByPostId.get(post.id) ?? [] };
			content[postCollection].push(seedEntry);
		}
	}

	const tagTerms = data.tags
		.filter((tag) => tag.slug)
		.map((tag) => ({
			slug: tag.slug,
			label: tag.name,
			description: tag.description ?? undefined,
		}));

	const redirects = uniqueRedirects([
		...(config.staticRedirects ?? []),
		...content[postCollection].map((entry) => buildPostRedirect(entry.slug, postRoutePrefix)),
	]);

	return {
		taxonomies: [
			{
				name: tagTaxonomyName,
				label: "Tags",
				labelSingular: "Tag",
				hierarchical: false,
				collections: [postCollection],
				terms: tagTerms,
			},
		],
		content,
		redirects,
	};
}
