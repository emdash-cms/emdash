/**
 * WordPress Plugin (EmDash Exporter) import source
 *
 * Connects to self-hosted WordPress sites running the EmDash Exporter plugin.
 * Provides full access to all content including drafts, custom post types, and ACF fields.
 */

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";

import { encodeBase64 } from "../../utils/base64.js";
import { ssrfSafeFetch, validateExternalUrl } from "../ssrf.js";
import type {
	ImportSource,
	ImportAnalysis,
	ImportContext,
	SourceInput,
	SourceProbeResult,
	I18nDetection,
	FetchOptions,
	NormalizedItem,
	PostTypeAnalysis,
	AttachmentInfo,
} from "../types.js";
import {
	BASE_REQUIRED_FIELDS,
	FEATURED_IMAGE_FIELD,
	mapPostTypeToCollection,
	mapWpStatus,
	normalizeUrl,
	checkSchemaCompatibility,
} from "../utils.js";

// =============================================================================
// API Response Types
// =============================================================================

/** Detected i18n plugin info from the WordPress site */
interface PluginI18nInfo {
	/** Which multilingual plugin is active */
	plugin: "wpml" | "polylang";
	/** BCP 47 default locale */
	default_locale: string;
	/** All configured locales */
	locales: string[];
}

/** Probe response from /emdash/v1/probe */
interface PluginProbeResponse {
	emdash_exporter: string;
	wordpress_version: string;
	site: {
		title: string;
		description: string;
		url: string;
		home: string;
		language: string;
		timezone: string;
	};
	capabilities: {
		application_passwords: boolean;
		acf: boolean;
		yoast: boolean;
		rankmath: boolean;
	};
	post_types: Array<{
		name: string;
		label: string;
		count: number;
	}>;
	media_count: number;
	endpoints: Record<string, string>;
	auth_instructions: {
		method: string;
		instructions: string;
		url?: string;
	};
	/** Detected multilingual plugin (WPML or Polylang). Absent when neither is active. */
	i18n?: PluginI18nInfo;
}

/** Analyze response from /emdash/v1/analyze */
interface PluginAnalyzeResponse {
	site: {
		title: string;
		url: string;
	};
	post_types: Array<{
		name: string;
		label: string;
		label_singular: string;
		total: number;
		by_status: Record<string, number>;
		supports: Record<string, unknown>;
		taxonomies: string[];
		custom_fields: Array<{
			key: string;
			count: number;
			inferred_type: string;
			sample: string | null;
		}>;
		hierarchical: boolean;
		has_archive: boolean;
	}>;
	taxonomies: Array<{
		name: string;
		label: string;
		hierarchical: boolean;
		term_count: number;
		object_types: string[];
	}>;
	authors: Array<{
		id: number;
		login: string;
		email: string;
		display_name: string;
		post_count: number;
	}>;
	attachments: {
		count: number;
		by_type: Record<string, number>;
	};
	acf?: Array<{
		key: string;
		title: string;
		fields: Array<{
			key: string;
			name: string;
			label: string;
			type: string;
			required: boolean;
		}>;
	}>;
	/** Detected multilingual plugin (WPML or Polylang). Absent when neither is active. */
	i18n?: PluginI18nInfo;
}

/** Content response from /emdash/v1/content */
interface PluginContentResponse {
	items: PluginPost[];
	total: number;
	pages: number;
	page: number;
	per_page: number;
}

/** Single post from plugin API */
interface PluginPost {
	id: number;
	post_type: string;
	status: string;
	slug: string;
	title: string;
	content: string;
	excerpt: string;
	date: string;
	date_gmt: string;
	modified: string;
	modified_gmt: string;
	author: {
		id: number;
		login: string;
		email: string;
		display_name: string;
	} | null;
	parent: number | null;
	menu_order: number;
	taxonomies: Record<string, Array<{ id: number; name: string; slug: string }>>;
	featured_image?: {
		id: number;
		url: string;
		filename: string;
		mime_type: string;
		alt: string;
		title: string;
		caption: string;
		width: number | null;
		height: number | null;
	};
	meta: Record<string, unknown>;
	acf?: Record<string, unknown>;
	yoast?: Record<string, string>;
	rankmath?: Record<string, string>;
	/** BCP 47 locale from WPML/Polylang (when detected) */
	locale?: string;
	/** Translation group ID from WPML trid or Polylang (when detected) */
	translation_group?: string;
}

/** Media response from /emdash/v1/media */
interface PluginMediaResponse {
	items: PluginMediaItem[];
	total: number;
	pages: number;
	page: number;
	per_page: number;
}

interface PluginMediaItem {
	id: number;
	url: string;
	filename: string;
	mime_type: string;
	title: string;
	alt: string;
	caption: string;
	description: string;
	width?: number;
	height?: number;
	filesize?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Pattern to remove spaces from application passwords */
const SPACE_PATTERN = /\s/g;

// =============================================================================
// Import Source
// =============================================================================

export const wordpressPluginSource: ImportSource = {
	id: "wordpress-plugin",
	name: "WordPress (EmDash Exporter)",
	description: "Import from WordPress sites with the EmDash Exporter plugin installed",
	icon: "plug",
	requiresFile: false,
	canProbe: true,

	async probe(url: string): Promise<SourceProbeResult | null> {
		try {
			const siteUrl = normalizeUrl(url);

			// SSRF protection: validate URL before any outbound requests
			validateExternalUrl(siteUrl);

			const probeUrl = `${siteUrl}/wp-json/emdash/v1/probe`;

			const response = await ssrfSafeFetch(probeUrl, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(10000),
			});

			if (!response.ok) {
				return null;
			}

			const data: PluginProbeResponse = await response.json();

			// Verify it's actually our plugin
			if (!data.emdash_exporter) {
				return null;
			}

			return {
				sourceId: "wordpress-plugin",
				confidence: "definite",
				detected: {
					platform: "wordpress",
					version: data.wordpress_version,
					siteTitle: data.site.title,
					siteUrl: data.site.url,
				},
				capabilities: {
					publicContent: true,
					privateContent: true, // Full access with auth
					customPostTypes: true,
					allMeta: true,
					mediaStream: true,
				},
				auth: data.capabilities.application_passwords
					? {
							type: "password",
							instructions: data.auth_instructions.instructions,
						}
					: undefined,
				preview: {
					posts: data.post_types.find((p) => p.name === "post")?.count,
					pages: data.post_types.find((p) => p.name === "page")?.count,
					media: data.media_count,
				},
				suggestedAction: {
					type: "proceed",
				},
				i18n: pluginI18nToDetection(data.i18n),
			};
		} catch {
			return null;
		}
	},

	async analyze(input: SourceInput, context: ImportContext): Promise<ImportAnalysis> {
		const { siteUrl, headers } = getRequestConfig(input);

		const response = await ssrfSafeFetch(`${siteUrl}/wp-json/emdash/v1/analyze`, {
			headers,
			signal: AbortSignal.timeout(30000),
		});

		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message =
				typeof body === "object" &&
				body !== null &&
				"message" in body &&
				typeof body.message === "string"
					? body.message
					: "";
			throw new Error(message || `Failed to analyze site: ${response.statusText}`);
		}

		const data: PluginAnalyzeResponse = await response.json();

		// Get existing collections for schema check
		const existingCollections = context.getExistingCollections
			? await context.getExistingCollections()
			: new Map();

		// Build post type analysis
		const postTypes: PostTypeAnalysis[] = data.post_types
			.filter((pt) => pt.total > 0)
			.map((pt) => {
				const suggestedCollection = mapPostTypeToCollection(pt.name);
				const existingCollection = existingCollections.get(suggestedCollection);

				// Include featured_image if post type supports thumbnails
				const supportsThumbnail = pt.supports && "thumbnail" in pt.supports;
				const requiredFields = supportsThumbnail
					? [...BASE_REQUIRED_FIELDS, FEATURED_IMAGE_FIELD]
					: [...BASE_REQUIRED_FIELDS];

				return {
					name: pt.name,
					count: pt.total,
					suggestedCollection,
					requiredFields,
					schemaStatus: checkSchemaCompatibility(requiredFields, existingCollection),
				};
			});

		// Fetch media list for attachment info
		const attachments: AttachmentInfo[] = [];
		if (data.attachments.count > 0) {
			try {
				// Fetch first page of media to populate attachment info
				const mediaResponse = await ssrfSafeFetch(
					`${siteUrl}/wp-json/emdash/v1/media?per_page=500`,
					{
						headers,
						signal: AbortSignal.timeout(30000),
					},
				);
				if (mediaResponse.ok) {
					const mediaData: PluginMediaResponse = await mediaResponse.json();
					for (const item of mediaData.items) {
						attachments.push({
							id: item.id,
							url: item.url,
							filename: item.filename,
							mimeType: item.mime_type,
							title: item.title,
							alt: item.alt,
							caption: item.caption,
							width: item.width,
							height: item.height,
						});
					}
				}
			} catch (e) {
				console.warn("Failed to fetch media list:", e);
			}
		}

		// Count categories and tags
		const categoryTaxonomy = data.taxonomies.find((t) => t.name === "category");
		const tagTaxonomy = data.taxonomies.find((t) => t.name === "post_tag");

		return {
			sourceId: "wordpress-plugin",
			site: {
				title: data.site.title,
				url: data.site.url,
			},
			postTypes,
			attachments: {
				count: data.attachments.count,
				items: attachments,
			},
			categories: categoryTaxonomy?.term_count ?? 0,
			tags: tagTaxonomy?.term_count ?? 0,
			authors: data.authors.map((a) => ({
				id: a.id,
				login: a.login,
				email: a.email,
				displayName: a.display_name,
				postCount: a.post_count,
			})),
			i18n: pluginI18nToDetection(data.i18n),
		};
	},

	async *fetchContent(input: SourceInput, options: FetchOptions): AsyncGenerator<NormalizedItem> {
		const { siteUrl, headers } = getRequestConfig(input);

		for (const postType of options.postTypes) {
			let page = 1;
			let totalPages = 1;
			let yielded = 0;

			while (page <= totalPages) {
				const status = options.includeDrafts ? "any" : "publish";
				const url = `${siteUrl}/wp-json/emdash/v1/content?post_type=${postType}&status=${status}&per_page=100&page=${page}`;

				const response = await ssrfSafeFetch(url, {
					headers,
					signal: AbortSignal.timeout(60000),
				});

				if (!response.ok) {
					throw new Error(`Failed to fetch ${postType}: ${response.statusText}`);
				}

				const data: PluginContentResponse = await response.json();
				totalPages = data.pages;

				for (const post of data.items) {
					yield pluginPostToNormalizedItem(post);
					yielded++;

					if (options.limit && yielded >= options.limit) {
						return;
					}
				}

				page++;
			}
		}
	},

	async fetchMedia(url: string, _input: SourceInput): Promise<Blob> {
		// SSRF protection: validate media URL before fetching
		validateExternalUrl(url);

		// Media URLs are publicly accessible on WP (ssrfSafeFetch validates redirects)
		const response = await ssrfSafeFetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch media: ${response.statusText}`);
		}
		return response.blob();
	},
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert plugin i18n info to the shared I18nDetection type.
 * Returns undefined when no multilingual plugin is detected.
 */
function pluginI18nToDetection(i18n: PluginI18nInfo | undefined): I18nDetection | undefined {
	if (!i18n) return undefined;
	return {
		plugin: i18n.plugin,
		defaultLocale: i18n.default_locale,
		locales: i18n.locales,
	};
}

/**
 * Get request configuration from input
 */
function getRequestConfig(input: SourceInput): {
	siteUrl: string;
	headers: HeadersInit;
} {
	if (input.type === "url") {
		const siteUrl = normalizeUrl(input.url);

		// SSRF protection: validate URL before any outbound requests
		validateExternalUrl(siteUrl);
		const headers: HeadersInit = {
			Accept: "application/json",
		};

		if (input.token) {
			// Token format: "username:password" base64 encoded
			headers["Authorization"] = `Basic ${input.token}`;
		}

		return { siteUrl, headers };
	}

	if (input.type === "oauth") {
		const oauthSiteUrl = normalizeUrl(input.url);

		// SSRF protection: validate URL before any outbound requests
		validateExternalUrl(oauthSiteUrl);

		return {
			siteUrl: oauthSiteUrl,
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${input.accessToken}`,
			},
		};
	}

	throw new Error("WordPress plugin source requires URL or OAuth input");
}

/**
 * Convert plugin post to normalized item
 */
function pluginPostToNormalizedItem(post: PluginPost): NormalizedItem {
	const content = post.content ? gutenbergToPortableText(post.content) : [];

	// Extract categories and tags from taxonomies
	const categories =
		post.taxonomies?.category?.map((c) => c.slug) ??
		post.taxonomies?.categories?.map((c) => c.slug) ??
		[];
	const tags =
		post.taxonomies?.post_tag?.map((t) => t.slug) ??
		post.taxonomies?.tags?.map((t) => t.slug) ??
		[];

	// Build meta from various sources
	const meta: Record<string, unknown> = { ...post.meta };

	// Include ACF fields in meta
	if (post.acf) {
		meta._acf = post.acf;
	}

	// Include SEO data in meta
	if (post.yoast) {
		meta._yoast = post.yoast;
	}
	if (post.rankmath) {
		meta._rankmath = post.rankmath;
	}

	return {
		sourceId: post.id,
		postType: post.post_type,
		status: mapWpStatus(post.status),
		slug: post.slug,
		title: post.title,
		content,
		excerpt: post.excerpt || undefined,
		date: new Date(post.date_gmt || post.date),
		modified: post.modified_gmt ? new Date(post.modified_gmt) : new Date(post.modified),
		author: post.author?.login,
		categories,
		tags,
		meta,
		featuredImage: post.featured_image?.url,
		locale: post.locale,
		translationGroup: post.translation_group,
	};
}

// =============================================================================
// Utility Functions for External Use
// =============================================================================

/**
 * Create a Basic Auth token from username and password
 */
export function createBasicAuthToken(username: string, password: string): string {
	// Remove spaces from application password (WP formats them with spaces)
	const cleanPassword = password.replace(SPACE_PATTERN, "");
	return encodeBase64(`${username}:${cleanPassword}`);
}

/**
 * Fetch media list from plugin API
 */
export async function fetchPluginMedia(
	siteUrl: string,
	authToken: string,
	page = 1,
	perPage = 100,
): Promise<PluginMediaResponse> {
	const normalizedSiteUrl = normalizeUrl(siteUrl);

	// SSRF protection: validate URL before any outbound requests
	validateExternalUrl(normalizedSiteUrl);

	const url = `${normalizedSiteUrl}/wp-json/emdash/v1/media?per_page=${perPage}&page=${page}`;

	const response = await ssrfSafeFetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Basic ${authToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch media: ${response.statusText}`);
	}

	return response.json();
}

/**
 * Fetch taxonomies from plugin API
 */
export async function fetchPluginTaxonomies(
	siteUrl: string,
	authToken: string,
): Promise<
	Array<{
		name: string;
		label: string;
		hierarchical: boolean;
		terms: Array<{
			id: number;
			name: string;
			slug: string;
			description: string;
			parent: number | null;
			count: number;
		}>;
	}>
> {
	const normalizedSiteUrl = normalizeUrl(siteUrl);

	// SSRF protection: validate URL before any outbound requests
	validateExternalUrl(normalizedSiteUrl);

	const url = `${normalizedSiteUrl}/wp-json/emdash/v1/taxonomies`;

	const response = await ssrfSafeFetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Basic ${authToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch taxonomies: ${response.statusText}`);
	}

	return response.json();
}
