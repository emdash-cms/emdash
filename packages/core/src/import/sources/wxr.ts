/**
 * WXR (WordPress eXtended RSS) import source
 *
 * Handles WordPress export file uploads (.xml).
 * This wraps the existing WXR parsing and analysis logic.
 */

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";

import { parseWxrString, type WxrData, type WxrPost } from "../../cli/wxr/parser.js";
import type {
	ImportSource,
	ImportAnalysis,
	ImportContext,
	SourceInput,
	FetchOptions,
	NormalizedItem,
	PostTypeAnalysis,
	AttachmentInfo,
	NavMenuAnalysis,
	TaxonomyAnalysis,
	ReusableBlockAnalysis,
} from "../types.js";
import {
	BASE_REQUIRED_FIELDS,
	FEATURED_IMAGE_FIELD,
	isInternalPostType,
	isInternalMetaKey,
	mapWpStatus,
	mapPostTypeToCollection,
	mapMetaKeyToField,
	inferMetaType,
	slugify,
	buildAttachmentMap,
	getFilenameFromUrl,
	guessMimeType,
	checkSchemaCompatibility,
} from "../utils.js";

export const wxrSource: ImportSource = {
	id: "wxr",
	name: "WordPress Export File",
	description: "Upload a WordPress export file (.xml)",
	icon: "upload",
	requiresFile: true,
	canProbe: false,

	async analyze(input: SourceInput, context: ImportContext): Promise<ImportAnalysis> {
		if (input.type !== "file") {
			throw new Error("WXR source requires a file input");
		}

		const text = await input.file.text();
		const wxr = await parseWxrString(text);

		// Get existing collections for schema compatibility check
		const existingCollections = context.getExistingCollections
			? await context.getExistingCollections()
			: new Map();

		return analyzeWxrData(wxr, existingCollections);
	},

	async *fetchContent(input: SourceInput, options: FetchOptions): AsyncGenerator<NormalizedItem> {
		if (input.type !== "file") {
			throw new Error("WXR source requires a file input");
		}

		const text = await input.file.text();
		const wxr = await parseWxrString(text);

		// Build attachment ID -> URL map for resolving featured images
		const attachmentMap = buildAttachmentMap(wxr.attachments);

		let count = 0;
		for (const post of wxr.posts) {
			const postType = post.postType || "post";

			// Skip if not in requested post types
			if (!options.postTypes.includes(postType)) {
				continue;
			}

			// Skip internal post types
			if (isInternalPostType(postType)) {
				continue;
			}

			// Skip drafts if not requested
			if (!options.includeDrafts && post.status !== "publish") {
				continue;
			}

			// Convert to normalized item
			yield wxrPostToNormalizedItem(post, attachmentMap);

			count++;
			if (options.limit && count >= options.limit) {
				break;
			}
		}
	},
};

/**
 * Analyze WXR data and return normalized ImportAnalysis
 */
function analyzeWxrData(
	wxr: WxrData,
	existingCollections: Map<string, { slug: string; fields: Map<string, { type: string }> }>,
): ImportAnalysis {
	// Count post types and track which have featured images
	const postTypeCounts = new Map<string, number>();
	const postTypesWithThumbnails = new Set<string>();
	const metaKeys = new Map<string, { count: number; samples: string[]; isInternal: boolean }>();
	const authorPostCounts = new Map<string, number>();

	for (const post of wxr.posts) {
		const type = post.postType || "post";
		postTypeCounts.set(type, (postTypeCounts.get(type) || 0) + 1);

		// Count posts per author (by login)
		if (post.creator) {
			authorPostCounts.set(post.creator, (authorPostCounts.get(post.creator) || 0) + 1);
		}

		// Track if this post type has featured images
		if (post.meta.has("_thumbnail_id")) {
			postTypesWithThumbnails.add(type);
		}

		// Analyze meta keys
		for (const [key, value] of post.meta) {
			const existing = metaKeys.get(key);
			if (existing) {
				existing.count++;
				if (existing.samples.length < 3 && value) {
					existing.samples.push(value.slice(0, 100));
				}
			} else {
				metaKeys.set(key, {
					count: 1,
					samples: value ? [value.slice(0, 100)] : [],
					isInternal: isInternalMetaKey(key),
				});
			}
		}
	}

	// Map meta keys to fields (for custom fields analysis)
	const customFields = [...metaKeys.entries()]
		.filter(([_, info]) => !info.isInternal)
		.map(([key, info]) => ({
			key,
			count: info.count,
			samples: info.samples,
			suggestedField: mapMetaKeyToField(key),
			suggestedType: inferMetaType(key, info.samples[0]),
			isInternal: info.isInternal,
		}))
		.toSorted((a, b) => b.count - a.count);

	// Build post type analysis with schema compatibility
	const postTypes: PostTypeAnalysis[] = [...postTypeCounts.entries()]
		.filter(([type]) => !isInternalPostType(type))
		.map(([name, count]) => {
			const suggestedCollection = mapPostTypeToCollection(name);
			const existingCollection = existingCollections.get(suggestedCollection);

			// Build required fields - add featured_image only if posts have thumbnails
			const requiredFields = [...BASE_REQUIRED_FIELDS];
			if (postTypesWithThumbnails.has(name)) {
				requiredFields.push(FEATURED_IMAGE_FIELD);
			}

			const schemaStatus = checkSchemaCompatibility(requiredFields, existingCollection);

			return {
				name,
				count,
				suggestedCollection,
				requiredFields,
				schemaStatus,
			};
		})
		.toSorted((a, b) => b.count - a.count);

	// Build attachment info list
	const attachmentItems: AttachmentInfo[] = wxr.attachments.map((att) => {
		const filename = att.url ? getFilenameFromUrl(att.url) : undefined;
		const mimeType = filename ? guessMimeType(filename) : undefined;
		return {
			id: att.id,
			title: att.title,
			url: att.url,
			filename,
			mimeType,
		};
	});

	// Analyze navigation menus
	const navMenus: NavMenuAnalysis[] = wxr.navMenus.map((menu) => ({
		name: menu.name,
		label: menu.label,
		itemCount: menu.items.length,
	}));

	// Analyze custom taxonomies (from wp:term elements, excluding category/post_tag/nav_menu)
	const taxonomyMap = new Map<string, { count: number; samples: string[] }>();
	for (const term of wxr.terms) {
		if (
			term.taxonomy === "category" ||
			term.taxonomy === "post_tag" ||
			term.taxonomy === "nav_menu"
		) {
			continue;
		}

		const existing = taxonomyMap.get(term.taxonomy);
		if (existing) {
			existing.count++;
			if (existing.samples.length < 3) {
				existing.samples.push(term.name);
			}
		} else {
			taxonomyMap.set(term.taxonomy, {
				count: 1,
				samples: [term.name],
			});
		}
	}

	const customTaxonomies: TaxonomyAnalysis[] = Array.from(
		taxonomyMap.entries(),
		([slug, info]) => ({
			slug,
			termCount: info.count,
			sampleTerms: info.samples,
		}),
	).toSorted((a, b) => b.termCount - a.termCount);

	// Analyze reusable blocks (wp_block post type)
	const reusableBlocks: ReusableBlockAnalysis[] = wxr.posts
		.filter((post) => post.postType === "wp_block")
		.map((post) => ({
			id: post.id || 0,
			title: post.title || "Untitled Block",
			slug: post.postName || slugify(post.title || `block-${post.id || Date.now()}`),
		}));

	return {
		sourceId: "wxr",
		site: {
			title: wxr.site.title || "WordPress Site",
			url: wxr.site.link || "",
		},
		postTypes,
		attachments: {
			count: wxr.attachments.length,
			items: attachmentItems,
		},
		categories: wxr.categories.length,
		tags: wxr.tags.length,
		authors: wxr.authors.map((a) => ({
			id: a.id,
			login: a.login,
			email: a.email,
			displayName: a.displayName || a.login || "Unknown",
			postCount: a.login ? authorPostCounts.get(a.login) || 0 : 0,
		})),
		navMenus: navMenus.length > 0 ? navMenus : undefined,
		customTaxonomies: customTaxonomies.length > 0 ? customTaxonomies : undefined,
		reusableBlocks: reusableBlocks.length > 0 ? reusableBlocks : undefined,
		customFields,
	};
}

/**
 * Convert a WXR post to a normalized item
 */
function wxrPostToNormalizedItem(
	post: WxrPost,
	attachmentMap: Map<string, string>,
): NormalizedItem {
	const content = post.content ? gutenbergToPortableText(post.content) : [];

	// Resolve featured image: _thumbnail_id is the attachment ID, look up the URL
	const thumbnailId = post.meta.get("_thumbnail_id");
	const featuredImage = thumbnailId ? attachmentMap.get(String(thumbnailId)) : undefined;

	// Convert custom taxonomies Map to Record
	let customTaxonomies: Record<string, string[]> | undefined;
	if (post.customTaxonomies && post.customTaxonomies.size > 0) {
		customTaxonomies = Object.fromEntries(post.customTaxonomies);
	}

	return {
		sourceId: post.id || 0,
		postType: post.postType || "post",
		status: mapWpStatus(post.status),
		slug: post.postName || slugify(post.title || `post-${post.id || Date.now()}`),
		title: post.title || "Untitled",
		content,
		excerpt: post.excerpt,
		date: parseWxrDate(post.postDateGmt, post.pubDate, post.postDate),
		modified: parseWxrDate(post.postModifiedGmt, undefined, post.postModified),
		author: post.creator,
		categories: post.categories,
		tags: post.tags,
		meta: Object.fromEntries(post.meta),
		featuredImage,
		// Hierarchical content support
		parentId: post.postParent && post.postParent !== 0 ? post.postParent : undefined,
		menuOrder: post.menuOrder,
		// Custom taxonomy assignments
		customTaxonomies,
	};
}

/**
 * WordPress uses "0000-00-00 00:00:00" as a sentinel for missing GMT dates
 * (e.g. unpublished drafts). This must be treated as absent.
 */
const WXR_ZERO_DATE = "0000-00-00 00:00:00";

/**
 * Parse a WXR date with the correct fallback chain:
 * 1. GMT date (always UTC, most reliable)
 * 2. pubDate (RFC 2822, includes timezone offset)
 * 3. Site-local date (MySQL datetime without timezone — imprecise but best available)
 * 4. Current time
 */
function parseWxrDate(
	gmtDate: string | undefined,
	pubDate: string | undefined,
	localDate: string | undefined,
): Date {
	if (gmtDate && gmtDate !== WXR_ZERO_DATE) {
		// GMT dates from WordPress are "YYYY-MM-DD HH:MM:SS" in UTC.
		// Append "Z" so the JS Date constructor treats them as UTC.
		return new Date(gmtDate.replace(" ", "T") + "Z");
	}

	if (pubDate) {
		// RFC 2822 format includes timezone offset, JS Date parses it correctly
		const d = new Date(pubDate);
		if (!isNaN(d.getTime())) return d;
	}

	if (localDate) {
		// Site-local time without timezone — normalize to ISO-like form so
		// runtimes that reject "YYYY-MM-DD HH:MM:SS" can still parse it as
		// local time. If parsing still fails, continue to the final fallback.
		const d = new Date(localDate.replace(" ", "T"));
		if (!isNaN(d.getTime())) return d;
	}

	return new Date();
}

// Export for use in other sources
export { analyzeWxrData, wxrPostToNormalizedItem };

// Re-export shared utilities that other sources may need
export {
	BASE_REQUIRED_FIELDS,
	FEATURED_IMAGE_FIELD,
	mapPostTypeToCollection,
	isInternalPostType,
	checkSchemaCompatibility,
} from "../utils.js";
