/**
 * WordPress Plugin execute import endpoint
 *
 * POST /_emdash/api/import/wordpress-plugin/execute
 *
 * Imports content from WordPress via EmDash Exporter plugin API.
 */

import type { APIRoute } from "astro";
import { ContentRepository, SchemaRegistry } from "emdash";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { wpPluginExecuteBody } from "#api/schemas.js";
import { BylineRepository } from "#db/repositories/byline.js";
import { getSource } from "#import/index.js";
import { resolveAndValidateExternalUrl, SsrfError } from "#import/ssrf.js";
import type { ImportConfig, ImportResult, NormalizedItem } from "#import/types.js";
import { resolveImportByline } from "#import/utils.js";
import type { FieldType } from "#schema/types.js";
import type { EmDashHandlers, EmDashManifest } from "#types";
import { slugify } from "#utils/slugify.js";

export const prerender = false;

export interface WpPluginImportConfig extends ImportConfig {
	/** Author mappings (WP author login -> EmDash user ID) */
	authorMappings?: Record<string, string | null>;
}

export interface WpPluginImportResponse {
	success: boolean;
	result?: ImportResult;
	error?: { message: string };
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleContentCreate) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const emdashManifest = await emdash.getManifest();

		const body = await parseBody(request, wpPluginExecuteBody);
		if (isParseError(body)) return body;

		// SSRF: reject internal/private network targets. Uses DNS resolution
		// to catch hostnames that resolve to private addresses.
		try {
			await resolveAndValidateExternalUrl(body.url);
		} catch (e) {
			const msg = e instanceof SsrfError ? e.message : "Invalid URL";
			return apiError("SSRF_BLOCKED", msg, 400);
		}

		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Zod schema output narrowed to WpPluginImportConfig
		const config = body.config as unknown as WpPluginImportConfig;

		// Get the WordPress plugin source
		const source = getSource("wordpress-plugin");
		if (!source) {
			return apiError("NOT_CONFIGURED", "WordPress plugin source not available", 500);
		}

		// Build the list of post types to fetch
		const postTypes = Object.entries(config.postTypeMappings)
			.filter(([_, mapping]) => mapping.enabled)
			.map(([postType]) => postType);

		if (postTypes.length === 0) {
			return apiError("VALIDATION_ERROR", "No post types selected for import", 400);
		}

		console.log("[WP Plugin Import] Starting import for:", body.url);
		console.log("[WP Plugin Import] Post types:", postTypes);

		// Import content (including drafts since we have auth)
		const result = await importContent(
			source.fetchContent(
				{ type: "url", url: body.url, token: body.token },
				{ postTypes, includeDrafts: true },
			),
			config,
			emdash,
			emdashManifest,
		);

		console.log("[WP Plugin Import] Import result:", JSON.stringify(result, null, 2));

		return apiSuccess({
			success: true,
			result,
		});
	} catch (error) {
		return handleError(error, "Failed to import from WordPress", "WP_PLUGIN_IMPORT_ERROR");
	}
};

/** Fields that should be auto-created if they don't exist */
const IMPORT_FIELDS: Array<{
	slug: string;
	label: string;
	type: FieldType;
	check: (item: NormalizedItem) => boolean;
}> = [
	{
		slug: "title",
		label: "Title",
		type: "string",
		check: () => true,
	},
	{
		slug: "content",
		label: "Content",
		type: "portableText",
		check: () => true,
	},
	{
		slug: "excerpt",
		label: "Excerpt",
		type: "text",
		check: (item) => !!item.excerpt,
	},
	{
		slug: "featured_image",
		label: "Featured Image",
		type: "image",
		check: (item) => !!item.featuredImage,
	},
];

async function importContent(
	items: AsyncGenerator<NormalizedItem>,
	config: WpPluginImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
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
	const schemaRegistry = new SchemaRegistry(emdash.db);

	// Track which collections have had fields ensured
	const ensuredCollections = new Set<string>();

	// Track source translationGroup -> EmDash item ID for translation linking.
	// Maps source-side translation group ID to the EmDash ID of the first item
	// imported for that group (the default-locale item).
	const translationGroupMap = new Map<string, string>();

	for await (const item of items) {
		console.log("[WP Plugin Import] Processing item:", {
			sourceId: item.sourceId,
			title: item.title,
			postType: item.postType,
			status: item.status,
			contentBlocks: Array.isArray(item.content) ? item.content.length : 0,
			featuredImage: item.featuredImage,
			locale: item.locale,
			translationGroup: item.translationGroup,
		});

		const mapping = config.postTypeMappings[item.postType];

		// Skip if not mapped or disabled
		if (!mapping || !mapping.enabled) {
			result.skipped++;
			continue;
		}

		const collection = mapping.collection;

		// Check if collection exists in manifest
		if (!manifest?.collections[collection]) {
			result.errors.push({
				title: item.title || "Untitled",
				error: `Collection "${collection}" does not exist`,
			});
			continue;
		}

		try {
			// Ensure required fields exist in the collection schema (once per collection)
			if (!ensuredCollections.has(collection)) {
				for (const field of IMPORT_FIELDS) {
					if (field.check(item)) {
						const existingField = await schemaRegistry.getField(collection, field.slug);
						if (!existingField) {
							console.log(
								`[WP Plugin Import] Creating missing field "${field.slug}" in collection "${collection}"`,
							);
							try {
								await schemaRegistry.createField(collection, {
									slug: field.slug,
									label: field.label,
									type: field.type,
									required: false,
								});
							} catch (e) {
								// Field might already exist from concurrent creation
								console.log(
									`[WP Plugin Import] Field "${field.slug}" creation skipped:`,
									e instanceof Error ? e.message : e,
								);
							}
						}
					}
				}
				ensuredCollections.add(collection);
			}

			// Generate slug from item slug or title
			const slug = item.slug || slugify(item.title || `post-${item.sourceId}`);

			// Check if already exists (idempotency) — locale-aware lookup
			if (config.skipExisting) {
				const existing = await contentRepo.findBySlug(collection, slug, item.locale);
				if (existing) {
					// Still track the translation group mapping for later items
					if (item.translationGroup) {
						translationGroupMap.set(item.translationGroup, existing.id);
					}
					result.skipped++;
					continue;
				}
			}

			// Map WordPress status to EmDash status
			const status = mapStatus(item.status);

			// Build data object - add all applicable fields
			const data: Record<string, unknown> = {};

			// Add standard fields
			data.title = item.title || "Untitled";
			data.content = item.content;

			if (item.excerpt) {
				data.excerpt = item.excerpt;
			}
			if (item.featuredImage) {
				data.featured_image = item.featuredImage;
				console.log("[WP Plugin Import] Adding featured_image:", item.featuredImage);
			}

			// Note: ACF/Yoast/RankMath fields are not added automatically
			// They would need matching fields in the EmDash schema

			// Resolve author ID from mappings
			let authorId: string | undefined;
			if (config.authorMappings && item.author) {
				const mappedUserId = config.authorMappings[item.author];
				if (mappedUserId !== undefined && mappedUserId !== null) {
					authorId = mappedUserId;
				}
			}

			const bylineId = await resolveImportByline(
				item.author,
				item.author, // display name fallback is the login
				authorId,
				bylineRepo,
				bylineCache,
			);

			// Resolve translation link: if this item has a translationGroup and
			// we've already imported another item in the same group, link them.
			let translationOf: string | undefined;
			if (item.translationGroup) {
				const existingGroupItem = translationGroupMap.get(item.translationGroup);
				if (existingGroupItem) {
					translationOf = existingGroupItem;
				}
			}

			// Preserve original dates from the source
			const itemDateTime = item.date?.getTime();
			const createdAt =
				itemDateTime !== undefined && !Number.isNaN(itemDateTime)
					? item.date.toISOString()
					: undefined;
			const publishedAt = status === "published" && createdAt ? createdAt : undefined;

			// Create the content item
			const createResult = await emdash.handleContentCreate(collection, {
				data,
				slug,
				status,
				authorId,
				bylines: bylineId ? [{ bylineId }] : undefined,
				locale: item.locale,
				translationOf,
				createdAt,
				publishedAt,
			});

			if (createResult.success) {
				result.imported++;
				result.byCollection[collection] = (result.byCollection[collection] || 0) + 1;

				// Track translation group: first item in a group establishes the mapping
				if (item.translationGroup && !translationGroupMap.has(item.translationGroup)) {
					// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler success data includes id
					const createdData = createResult.data as { id?: string } | undefined;
					if (createdData?.id) {
						translationGroupMap.set(item.translationGroup, createdData.id);
					}
				}
			} else {
				result.errors.push({
					title: item.title || "Untitled",
					error:
						typeof createResult.error === "object" && createResult.error !== null
							? (createResult.error as { message?: string }).message || "Unknown error"
							: String(createResult.error),
				});
			}
		} catch (error) {
			console.error(`Import error for "${item.title || "Untitled"}":`, error);
			result.errors.push({
				title: item.title || "Untitled",
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
