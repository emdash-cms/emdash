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
import { TaxonomyRepository } from "#db/repositories/taxonomy.js";
import { resolveImportByline } from "#import/utils.js";
import {
	attachPostTaxonomies,
	mirrorTermsToLocales,
	postAssignedTaxonomies,
	preImportWxrTaxonomies,
	type TaxonomyImportPlan,
} from "#import/wxr-taxonomies.js";
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
	/** Taxonomy import results (categories, tags, custom taxonomies). */
	taxonomies?: {
		/** Terms newly created during this import, keyed by taxonomy name. */
		termsCreated: Record<string, number>;
		/** Existing terms that were re-used, keyed by taxonomy name. */
		termsReused: Record<string, number>;
		/** Total pivot rows (post <-> term) written to `content_taxonomies`. */
		assignments: number;
		/**
		 * Custom taxonomy names from the WXR file that had no matching EmDash
		 * definition and were therefore skipped. Lets the admin UI surface a
		 * "create taxonomy X first" hint without re-running the import.
		 */
		missingTaxonomies: string[];
	};
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

		// Pre-create taxonomy terms (categories, tags, custom taxonomies) so
		// per-post assignments can resolve to existing rows. Done before any
		// content insert because WXR exports list terms at the top of the
		// file but per-item assignments only reference them by slug.
		const taxonomyPlan = await preImportWxrTaxonomies(
			emdash.db,
			wxr.posts,
			wxr.categories,
			wxr.tags,
			wxr.terms,
			config.locale,
		);

		// Multilingual imports (WPML / Polylang -- see #1080) need a term
		// row at each per-post locale, all sharing the canonical term's
		// `translation_group`. Without this, `getTermsForEntry(..., locale)`
		// on non-canonical translations comes back empty.
		const postLocales = new Set<string>();
		for (const post of wxr.posts) {
			if (post.locale) postLocales.add(post.locale);
		}
		if (postLocales.size > 0) {
			await mirrorTermsToLocales(emdash.db, taxonomyPlan, postLocales, config.locale);
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
			taxonomyPlan,
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

export async function importContent(
	posts: WxrPost[],
	config: ImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
	attachmentMap: Map<string, string>,
	locale: string | undefined,
	authorDisplayNames: Map<string, string> | undefined,
	taxonomyPlan: TaxonomyImportPlan,
): Promise<ImportResult> {
	const result: ImportResult = {
		success: true,
		imported: 0,
		skipped: 0,
		errors: [],
		byCollection: {},
		taxonomies: {
			termsCreated: taxonomyPlan.termsCreated,
			termsReused: taxonomyPlan.termsReused,
			assignments: 0,
			missingTaxonomies: taxonomyPlan.missingTaxonomies,
		},
	};

	// Create content repository for checking existing items
	const contentRepo = new ContentRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const taxonomyRepo = new TaxonomyRepository(emdash.db);
	const bylineCache = new Map<string, string>();

	// Source-side translation group ID -> the EmDash ID of the first post we
	// imported for that group. Subsequent translations are linked via
	// `translationOf` so they share a `translation_group` on the EmDash side.
	const translationGroupMap = new Map<string, string>();

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

			// Per-post locale: prefer the value extracted from WPML/Polylang
			// metadata; fall back to the upload-wide locale. Two translations
			// sharing `post_name` (e.g. /en/hello + /ar/hello) collide on the
			// `UNIQUE(slug, locale)` constraint when they share a locale, so
			// honouring the per-post value is what makes multilingual imports
			// land correctly. See issue #1080.
			const postLocale = post.locale ?? locale;

			// Check if already exists (idempotency). Match against the
			// per-post locale so the same slug in different locales doesn't
			// false-positive as duplicate.
			if (config.skipExisting) {
				const existing = await contentRepo.findBySlug(collection, slug, postLocale);
				if (existing) {
					// Still record the translation group mapping so later
					// translations can link to the existing item.
					if (post.translationGroup) {
						translationGroupMap.set(post.translationGroup, existing.id);
					}
					result.skipped++;
					continue;
				}
			}

			// Resolve translation group: if this post belongs to a group and
			// we've already imported one of its translations, link to it.
			let translationOf: string | undefined;
			if (post.translationGroup) {
				translationOf = translationGroupMap.get(post.translationGroup);
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
				locale: postLocale,
				translationOf,
				createdAt,
				publishedAt,
			});

			if (createResult.success) {
				result.imported++;
				result.byCollection[collection] = (result.byCollection[collection] || 0) + 1;

				// `handleContentCreate` returns `data: { item, _rev? }` on
				// success (see `ApiResult<ContentResponse>` in
				// `api/handlers/content.ts`). `HandlerResponse.data` is
				// typed as `unknown` to avoid coupling the route surface to
				// internal handler types, so we narrow here.
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler contract documented at handleContentCreate
				const createdItem = (createResult.data as { item: { id: string } } | undefined)?.item;

				// Track translation group: the first imported post in a group
				// becomes the anchor that later translations link to.
				if (
					createdItem &&
					post.translationGroup &&
					!translationGroupMap.has(post.translationGroup)
				) {
					translationGroupMap.set(post.translationGroup, createdItem.id);
				}

				// Attach taxonomy assignments parsed from the WXR's per-item
				// <category> elements. Called for every post -- anchors and
				// translations -- because WPML / Polylang permit per-
				// translation term assignments.
				//
				// Translations created via `translationOf` inherit the
				// anchor's pivot rows through `ContentRepository.create ->
				// copyEntryTerms`. WPML's "Translate Independently" mode
				// lets translators override term assignments *per
				// taxonomy*, not per post: a translation that picks its
				// own `category` shouldn't lose its inherited `tag` or
				// `genre` rows. We clear the pivot only for taxonomies
				// the translation explicitly carries, then attach from the
				// WXR. Translations with no per-item assignments fall
				// through with the entire inherited set intact -- matches
				// WPML "Sync translations" mode and Polylang's default.
				if (createdItem) {
					try {
						if (translationOf) {
							const overriddenTaxonomies = postAssignedTaxonomies(post);
							for (const taxonomyName of overriddenTaxonomies) {
								// `setTermsForEntry(name, [])` deletes only
								// pivot rows for this taxonomy, leaving
								// other inherited taxonomies untouched.
								await taxonomyRepo.setTermsForEntry(collection, createdItem.id, taxonomyName, []);
							}
						}
						const written = await attachPostTaxonomies(
							emdash.db,
							collection,
							createdItem.id,
							post,
							taxonomyPlan,
						);
						if (result.taxonomies) {
							result.taxonomies.assignments += written;
						}
					} catch (taxError) {
						console.error(
							`Failed to attach taxonomies for "${post.title || "Untitled"}":`,
							taxError,
						);
						result.errors.push({
							title: post.title || "Untitled",
							error:
								taxError instanceof Error && taxError.message
									? `Imported but failed to attach taxonomies: ${taxError.message}`
									: "Imported but failed to attach taxonomies",
						});
					}
				}
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
