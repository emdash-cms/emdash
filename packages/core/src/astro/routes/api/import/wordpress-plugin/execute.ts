/**
 * WordPress Plugin execute import endpoint
 *
 * POST /_emdash/api/import/wordpress-plugin/execute
 *
 * Imports content from WordPress via EmDash Exporter plugin API.
 */

import type { APIRoute } from "astro";
import {
	ContentRepository,
	SchemaRegistry,
	type WxrCategory,
	type WxrPost,
	type WxrTag,
	type WxrTerm,
} from "emdash";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { wpPluginExecuteBody } from "#api/schemas.js";
import { BylineRepository } from "#db/repositories/byline.js";
import { getSource } from "#import/index.js";
import { importMenusFromPlugin } from "#import/menus.js";
import { fetchPluginMenus, fetchPluginTaxonomies } from "#import/sources/wordpress-plugin.js";
import { resolveAndValidateExternalUrl, SsrfError } from "#import/ssrf.js";
import type { ImportConfig, ImportResult, NormalizedItem } from "#import/types.js";
import { resolveImportByline } from "#import/utils.js";
import {
	attachPostTaxonomies,
	preImportWxrTaxonomies,
	type TaxonomyImportPlan,
} from "#import/wxr-taxonomies.js";
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

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Zod schema output narrowed to WpPluginImportConfig
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

		// Pre-create taxonomy terms so per-post assignments can attach.
		// Non-fatal: a site whose /taxonomies call fails still gets content.
		let taxonomyPlan: TaxonomyImportPlan | undefined;
		try {
			taxonomyPlan = await buildTaxonomyPlan(emdash, body.url, body.token);
		} catch (e) {
			console.warn("[WP Plugin Import] Taxonomy pre-import failed:", e);
		}

		// Import content (including drafts since we have auth)
		const { result, contentIdMap } = await importContent(
			source.fetchContent(
				{ type: "url", url: body.url, token: body.token },
				{ postTypes, includeDrafts: true },
			),
			config,
			emdash,
			emdashManifest,
			taxonomyPlan,
		);

		// Import navigation menus, resolving item references through the
		// WP-post-ID -> EmDash-ID map collected during the content pass.
		// Non-fatal: older plugin versions have no /menus endpoint.
		try {
			const menus = await fetchPluginMenus(body.url, body.token);
			if (menus.length > 0) {
				const menuResult = await importMenusFromPlugin(menus, emdash.db, contentIdMap);
				result.menus = {
					created: menuResult.menusCreated,
					items: menuResult.itemsCreated,
				};
				for (const menuError of menuResult.errors) {
					result.errors.push({ title: `Menu: ${menuError.menu}`, error: menuError.error });
				}
			}
		} catch (e) {
			console.warn("[WP Plugin Import] Menu import failed:", e);
		}

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
	{
		slug: "seo_title",
		label: "SEO Title",
		type: "string",
		check: (item) => !!extractSeo(item).title,
	},
	{
		slug: "seo_description",
		label: "SEO Description",
		type: "text",
		check: (item) => !!extractSeo(item).description,
	},
];

/**
 * Pull the per-post SEO title/description out of the Yoast / Rank Math
 * blobs the plugin source stashes in `item.meta`. Empty strings mean "not
 * overridden for this post" (the plugin exports the raw meta values) and
 * are treated as absent.
 */
function pickSeoValue(blob: unknown, key: string): string | undefined {
	if (typeof blob !== "object" || blob === null) return undefined;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to non-null object above
	const value = (blob as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function extractSeo(item: NormalizedItem): { title?: string; description?: string } {
	const yoast = item.meta?._yoast;
	const rankmath = item.meta?._rankmath;
	return {
		title: pickSeoValue(yoast, "title") ?? pickSeoValue(rankmath, "title"),
		description: pickSeoValue(yoast, "description") ?? pickSeoValue(rankmath, "description"),
	};
}

/**
 * Fetch the site's taxonomies from the plugin API and pre-create all terms,
 * reusing the WXR taxonomy machinery (same def-lookup, idempotency, and
 * collection-filter semantics).
 */
async function buildTaxonomyPlan(
	emdash: EmDashHandlers,
	url: string,
	token: string,
): Promise<TaxonomyImportPlan> {
	const taxonomies = await fetchPluginTaxonomies(url, token);

	const categories: WxrCategory[] = [];
	const tags: WxrTag[] = [];
	const terms: WxrTerm[] = [];

	for (const taxonomy of taxonomies) {
		for (const term of taxonomy.terms) {
			if (taxonomy.name === "category") {
				categories.push({ nicename: term.slug, name: term.name, description: term.description });
			} else if (taxonomy.name === "post_tag") {
				tags.push({ slug: term.slug, name: term.name, description: term.description });
			} else if (taxonomy.name !== "nav_menu" && taxonomy.name !== "post_format") {
				terms.push({
					id: term.id,
					taxonomy: taxonomy.name,
					slug: term.slug,
					name: term.name,
					description: term.description,
				});
			}
		}
	}

	return preImportWxrTaxonomies(emdash.db, [], categories, tags, terms, undefined);
}

/**
 * Adapt a NormalizedItem's taxonomy assignments to the WxrPost shape the
 * shared attach helper consumes.
 */
function toWxrAssignments(item: NormalizedItem): WxrPost {
	return {
		categories: item.categories ?? [],
		tags: item.tags ?? [],
		customTaxonomies: item.customTaxonomies
			? new Map(Object.entries(item.customTaxonomies))
			: undefined,
		meta: new Map(),
	};
}

async function importContent(
	items: AsyncGenerator<NormalizedItem>,
	config: WpPluginImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
	taxonomyPlan: TaxonomyImportPlan | undefined,
): Promise<{ result: ImportResult; contentIdMap: Map<number, string> }> {
	const result: ImportResult = {
		success: true,
		imported: 0,
		skipped: 0,
		errors: [],
		byCollection: {},
	};

	// WP post ID -> EmDash content ID, used to resolve menu item references
	const contentIdMap = new Map<number, string>();

	// Create content repository for checking existing items
	const contentRepo = new ContentRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const bylineCache = new Map<string, string>();
	const schemaRegistry = new SchemaRegistry(emdash.db);

	// Track which collections have had fields ensured
	const ensuredCollections = new Set<string>();

	// Field slugs per collection, for mapping custom meta/ACF onto real fields
	const fieldSlugsByCollection = new Map<string, Set<string>>();

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

			// Load the collection's field slugs once, so custom meta / ACF
			// values can land in matching schema fields (created by the
			// prepare step or already present).
			let fieldSlugs = fieldSlugsByCollection.get(collection);
			if (!fieldSlugs) {
				fieldSlugs = new Set<string>();
				const collectionDef = await schemaRegistry.getCollection(collection);
				if (collectionDef) {
					for (const field of await schemaRegistry.listFields(collectionDef.id)) {
						fieldSlugs.add(field.slug);
					}
				}
				fieldSlugsByCollection.set(collection, fieldSlugs);
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
					// Menus may reference this post even when we skip it
					const wpId = Number(item.sourceId);
					if (Number.isFinite(wpId)) {
						contentIdMap.set(wpId, existing.id);
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

			// Per-post SEO overrides from Yoast / Rank Math
			const seo = extractSeo(item);
			if (seo.title) {
				data.seo_title = seo.title;
			}
			if (seo.description) {
				data.seo_description = seo.description;
			}

			// Map ACF values and custom meta onto schema fields with the same
			// slug (typically created by the prepare step from the analysis).
			// Values without a matching field are dropped -- the user controls
			// the schema, we don't invent fields per meta key.
			const acf = item.meta?._acf;
			if (typeof acf === "object" && acf !== null) {
				for (const [key, value] of Object.entries(acf)) {
					if (!(key in data) && fieldSlugs.has(key) && value !== null && value !== "") {
						data[key] = value;
					}
				}
			}
			if (item.meta) {
				for (const [key, value] of Object.entries(item.meta)) {
					// Underscore keys are WP-internal or handled above (_acf/_yoast/_rankmath)
					if (key.startsWith("_")) continue;
					if (!(key in data) && fieldSlugs.has(key) && value !== null && value !== "") {
						data[key] = value;
					}
				}
			}

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

				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- handler success data includes id
				const createdData = createResult.data as { id?: string } | undefined;
				const createdId = createdData?.id;

				if (createdId) {
					const wpId = Number(item.sourceId);
					if (Number.isFinite(wpId)) {
						contentIdMap.set(wpId, createdId);
					}

					// Attach category/tag/custom-taxonomy assignments
					if (taxonomyPlan) {
						try {
							const attached = await attachPostTaxonomies(
								emdash.db,
								collection,
								createdId,
								toWxrAssignments(item),
								taxonomyPlan,
							);
							if (attached > 0) {
								result.taxonomyAssignments = (result.taxonomyAssignments ?? 0) + attached;
							}
						} catch (e) {
							console.warn(`[WP Plugin Import] Taxonomy attach failed for "${slug}":`, e);
						}
					}
				}

				// Track translation group: first item in a group establishes the mapping
				if (item.translationGroup && !translationGroupMap.has(item.translationGroup) && createdId) {
					translationGroupMap.set(item.translationGroup, createdId);
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

	if (taxonomyPlan && taxonomyPlan.missingTaxonomies.length > 0) {
		result.missingTaxonomies = taxonomyPlan.missingTaxonomies;
	}

	result.success = result.errors.length === 0;
	return { result, contentIdMap };
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
