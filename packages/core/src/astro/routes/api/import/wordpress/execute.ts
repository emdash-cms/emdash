/**
 * WordPress WXR execute import endpoint
 *
 * POST /_emdash/api/import/wordpress/execute
 *
 * Accepts WXR file and import configuration, imports content into the database.
 */

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import type { APIRoute } from "astro";
import {
	parseWxrString,
	ContentRepository,
	importReusableBlocksAsSections,
	type WxrPost,
	parseWxrDate,
} from "emdash";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { BylineRepository } from "#db/repositories/byline.js";
import { resolveImportByline } from "#import/utils.js";
import type { EmDashHandlers, EmDashManifest } from "#types";
import { slugify } from "#utils/slugify.js";

import { sanitizeSlug } from "./analyze.js";

export const prerender = false;

export interface ImportConfig {
	/** Map WordPress post types to EmDash collections */
	postTypeMappings: Record<
		string,
		{
			collection: string;
			enabled: boolean;
		}
	>;
	/** Whether to skip items that already exist (by slug) */
	skipExisting: boolean;
	/** Whether to import reusable blocks (wp_block) as sections */
	importSections?: boolean;
	/** Author mappings (WP author login -> EmDash user ID) */
	authorMappings?: Record<string, string | null>;
	/** BCP 47 locale for all imported items. When omitted, defaults to defaultLocale. */
	locale?: string;
}

export interface ImportResult {
	success: boolean;
	imported: number;
	skipped: number;
	errors: Array<{ title: string; error: string }>;
	byCollection: Record<string, number>;
	/** Sections import results (if enabled) */
	sections?: {
		created: number;
		skipped: number;
	};
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleContentCreate) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const emdashManifest = await emdash.getManifest();

	try {
		const formData = await request.formData();
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;
		const configEntry = formData.get("config");
		const configJson = typeof configEntry === "string" ? configEntry : null;

		if (!file) {
			return apiError("VALIDATION_ERROR", "No file provided", 400);
		}

		if (!configJson) {
			return apiError("VALIDATION_ERROR", "No config provided", 400);
		}

		const config: ImportConfig = JSON.parse(configJson);

		// Parse WXR
		const text = await file.text();
		const wxr = await parseWxrString(text);

		// Build attachment ID -> URL map for featured images
		const attachmentMap = new Map<string, string>();
		for (const att of wxr.attachments) {
			if (att.id && att.url) {
				attachmentMap.set(String(att.id), att.url);
			}
		}

		// Build author login -> display name map
		const authorDisplayNames = new Map<string, string>();
		for (const author of wxr.authors) {
			if (!author.login) continue;
			authorDisplayNames.set(author.login, author.displayName || author.login);
		}

		// Import content (locale from config scopes all items)
		const result = await importContent(
			wxr.posts,
			config,
			emdash,
			emdashManifest,
			attachmentMap,
			config.locale,
			authorDisplayNames,
		);

		// Import reusable blocks as sections (if enabled)
		if (config.importSections !== false) {
			const sectionsResult = await importReusableBlocksAsSections(wxr.posts, emdash.db);
			result.sections = {
				created: sectionsResult.sectionsCreated,
				skipped: sectionsResult.sectionsSkipped,
			};
			// Add section errors to main errors array
			result.errors.push(...sectionsResult.errors);
			if (sectionsResult.errors.length > 0) {
				result.success = false;
			}
		}

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Failed to import content", "WXR_IMPORT_ERROR");
	}
};

async function importContent(
	posts: WxrPost[],
	config: ImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
	attachmentMap: Map<string, string>,
	locale?: string,
	authorDisplayNames?: Map<string, string>,
): Promise<ImportResult> {
	const result: ImportResult = {
		success: true,
		imported: 0,
		skipped: 0,
		errors: [],
		byCollection: {},
	};

	// Create content repository for checking existing items
	const contentRepo = new ContentRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const bylineCache = new Map<string, string>();

	for (const post of posts) {
		const postType = post.postType || "post";
		const mapping = config.postTypeMappings[postType];

		// Skip if not mapped or disabled
		if (!mapping || !mapping.enabled) {
			result.skipped++;
			continue;
		}

		// Defensive: mapping.collection is already sanitized by prepare, but the user
		// could manually edit the import config between prepare and execute.
		const collection = sanitizeSlug(mapping.collection);

		// Check if collection exists in manifest
		if (!manifest?.collections[collection]) {
			result.errors.push({
				title: post.title || "Untitled",
				error: `Collection "${collection}" does not exist`,
			});
			continue;
		}

		try {
			// Convert content to Portable Text
			const content = post.content ? gutenbergToPortableText(post.content) : [];

			// Generate slug from post name or title
			const slug = post.postName || slugify(post.title || `post-${post.id || Date.now()}`);

			// Check if already exists (idempotency)
			if (config.skipExisting) {
				const existing = await contentRepo.findBySlug(collection, slug);
				if (existing) {
					result.skipped++;
					continue;
				}
			}

			// Map WordPress status to EmDash status
			const status = mapStatus(post.status);

			// Build data object with required fields
			const data: Record<string, unknown> = {
				title: post.title || "Untitled",
				content,
				excerpt: post.excerpt || undefined,
			};

			// Only add featured_image if the collection has this field and we have a value
			const collectionSchema = manifest.collections[collection];
			const hasFeaturedImageField = collectionSchema?.fields
				? "featured_image" in collectionSchema.fields
				: false;
			if (hasFeaturedImageField) {
				const thumbnailId = post.meta.get("_thumbnail_id");
				const featuredImage = thumbnailId ? attachmentMap.get(String(thumbnailId)) : undefined;
				if (featuredImage) {
					data.featured_image = featuredImage;
				}
			}

			// Resolve author ID from mappings
			let authorId: string | undefined;
			if (config.authorMappings && post.creator) {
				const mappedUserId = config.authorMappings[post.creator];
				if (mappedUserId !== undefined && mappedUserId !== null) {
					authorId = mappedUserId;
				}
			}

			const bylineId = await resolveImportByline(
				post.creator,
				authorDisplayNames?.get(post.creator ?? "") ?? post.creator,
				authorId,
				bylineRepo,
				bylineCache,
			);

			// Preserve original WordPress dates using the shared WXR date parser.
			// Fallback chain: postDateGmt (UTC) → pubDate (RFC 2822) → postDate (site-local).
			const parsedDate = parseWxrDate(post.postDateGmt, post.pubDate, post.postDate);
			const createdAt = parsedDate ? parsedDate.toISOString() : undefined;
			const publishedAt = status === "published" && createdAt ? createdAt : undefined;

			// Create the content item
			const createResult = await emdash.handleContentCreate(collection, {
				data,
				slug,
				status,
				authorId,
				bylines: bylineId ? [{ bylineId }] : undefined,
				locale,
				createdAt,
				publishedAt,
			});

			if (createResult.success) {
				result.imported++;
				result.byCollection[collection] = (result.byCollection[collection] || 0) + 1;
			} else {
				result.errors.push({
					title: post.title || "Untitled",
					error:
						typeof createResult.error === "object" && createResult.error !== null
							? (createResult.error as { message?: string }).message || "Unknown error"
							: String(createResult.error),
				});
			}
		} catch (error) {
			console.error(`Import error for "${post.title || "Untitled"}":`, error);
			result.errors.push({
				title: post.title || "Untitled",
				error: error instanceof Error && error.message ? error.message : "Failed to import item",
			});
		}
	}

	result.success = result.errors.length === 0;
	return result;
}

function mapStatus(wpStatus: string | undefined): string {
	switch (wpStatus) {
		case "publish":
			return "published";
		case "draft":
			return "draft";
		case "pending":
			return "draft";
		case "private":
			return "draft";
		default:
			return "draft";
	}
}
