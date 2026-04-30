/**
 * Seed engine - applies seed files to database
 *
 * This is the core implementation that bootstraps an EmDash site from a seed file.
 * Apply order is critical for foreign keys and references.
 */

import { imageSize } from "image-size";
import type { Kysely } from "kysely";
import mime from "mime/lite";
import { ulid } from "ulidx";

import { BylineRepository } from "../database/repositories/byline.js";
import { ContentRepository } from "../database/repositories/content.js";
import { MediaRepository } from "../database/repositories/media.js";
import { RedirectRepository } from "../database/repositories/redirect.js";
import { RevisionRepository } from "../database/repositories/revision.js";
import { TaxonomyRepository } from "../database/repositories/taxonomy.js";
import { withTransaction } from "../database/transaction.js";
import type { Database } from "../database/types.js";
import type { MediaValue } from "../fields/types.js";
import { ssrfSafeFetch, validateExternalUrl } from "../import/ssrf.js";
import { SchemaRegistry } from "../schema/registry.js";
import { FTSManager } from "../search/fts-manager.js";
import { setSiteSettings } from "../settings/index.js";
import type { Storage } from "../storage/types.js";
import type {
	SeedFile,
	SeedApplyOptions,
	SeedApplyResult,
	SeedTaxonomyTerm,
	SeedMenuItem,
	SeedWidget,
	SeedMediaReference,
} from "./types.js";

const FILE_EXTENSION_PATTERN = /\.([a-z0-9]+)(?:\?|$)/i;
import { normalizePortableTextKeys } from "./normalize-portable-text.js";
import { validateSeed } from "./validate.js";

/** Pattern to remove file extensions */
const EXTENSION_PATTERN = /\.[^.]+$/;

/** Pattern to remove query parameters */
const QUERY_PARAM_PATTERN = /\?.*$/;

/** Pattern to remove non-alphanumeric characters (except dash and underscore) */
const SANITIZE_PATTERN = /[^a-zA-Z0-9_-]/g;

/** Pattern to collapse multiple hyphens */
const MULTIPLE_HYPHENS_PATTERN = /-+/g;

/**
 * Apply a seed file to the database
 *
 * This function is idempotent - safe to run multiple times.
 *
 * @param db - Kysely database instance
 * @param seed - Seed file to apply
 * @param options - Application options
 * @returns Result summary
 */
export async function applySeed(
	db: Kysely<Database>,
	seed: SeedFile,
	options: SeedApplyOptions = {},
): Promise<SeedApplyResult> {
	// Validate seed first
	const validation = validateSeed(seed);
	if (!validation.valid) {
		throw new Error(`Invalid seed file:\n${validation.errors.join("\n")}`);
	}

	const {
		includeContent = false,
		storage,
		skipMediaDownload = false,
		onConflict = "skip",
	} = options;

	// Result counters
	const result: SeedApplyResult = {
		collections: { created: 0, skipped: 0, updated: 0 },
		fields: { created: 0, skipped: 0, updated: 0 },
		taxonomies: { created: 0, terms: 0 },
		bylines: { created: 0, skipped: 0, updated: 0 },
		menus: { created: 0, items: 0 },
		redirects: { created: 0, skipped: 0, updated: 0 },
		widgetAreas: { created: 0, widgets: 0 },
		sections: { created: 0, skipped: 0, updated: 0 },
		settings: { applied: 0 },
		content: { created: 0, skipped: 0, updated: 0 },
		media: { created: 0, skipped: 0 },
	};

	// Media context for $media resolution
	const mediaContext: MediaContext = {
		db,
		storage: storage ?? null,
		skipMediaDownload,
		mediaCache: new Map(), // Cache downloaded media by URL to avoid re-downloading
	};

	// Apply order (critical for foreign keys and references):
	// 1. Site settings
	// 2. Collections + Fields
	// 3. Taxonomy definitions + Terms
	// 4. Content (so menu refs can resolve)
	// 5. Menus + Menu items (can now resolve content refs)
	// 6. Redirects
	// 7. Widget areas + Widgets

	// Track seed content IDs for reference resolution (shared across content and menus)
	const seedIdMap = new Map<string, string>(); // seed id -> real entry id
	const seedBylineIdMap = new Map<string, string>(); // seed byline id -> real byline id

	// 1. Site settings
	if (seed.settings) {
		await setSiteSettings(seed.settings, db);
		result.settings.applied = Object.keys(seed.settings).length;
	}

	// 2-3. Collections and Fields
	if (seed.collections) {
		const registry = new SchemaRegistry(db);

		for (const collection of seed.collections) {
			// Check if collection exists
			const existing = await registry.getCollection(collection.slug);

			if (existing) {
				if (onConflict === "error") {
					throw new Error(`Conflict: collection "${collection.slug}" already exists`);
				}

				if (onConflict === "update") {
					await registry.updateCollection(collection.slug, {
						label: collection.label,
						labelSingular: collection.labelSingular,
						description: collection.description,
						icon: collection.icon,
						supports: collection.supports || [],
						urlPattern: collection.urlPattern,
						commentsEnabled: collection.commentsEnabled,
					});
					result.collections.updated++;

					// Update or create fields
					for (const field of collection.fields) {
						const existingField = await registry.getField(collection.slug, field.slug);
						if (existingField) {
							await registry.updateField(collection.slug, field.slug, {
								label: field.label,
								required: field.required || false,
								unique: field.unique || false,
								searchable: field.searchable || false,
								defaultValue: field.defaultValue,
								validation: field.validation,
								widget: field.widget,
								options: field.options,
							});
							result.fields.updated++;
						} else {
							await registry.createField(collection.slug, {
								slug: field.slug,
								label: field.label,
								type: field.type,
								required: field.required || false,
								unique: field.unique || false,
								searchable: field.searchable || false,
								defaultValue: field.defaultValue,
								validation: field.validation,
								widget: field.widget,
								options: field.options,
							});
							result.fields.created++;
						}
					}
					continue;
				}

				// skip
				result.collections.skipped++;
				result.fields.skipped += collection.fields.length;
				continue;
			}

			// Create collection
			await registry.createCollection({
				slug: collection.slug,
				label: collection.label,
				labelSingular: collection.labelSingular,
				description: collection.description,
				icon: collection.icon,
				supports: collection.supports || [],
				source: "seed",
				urlPattern: collection.urlPattern,
				commentsEnabled: collection.commentsEnabled,
			});
			result.collections.created++;

			// Create fields
			for (const field of collection.fields) {
				await registry.createField(collection.slug, {
					slug: field.slug,
					label: field.label,
					type: field.type,
					required: field.required || false,
					unique: field.unique || false,
					searchable: field.searchable || false,
					defaultValue: field.defaultValue,
					validation: field.validation,
					widget: field.widget,
					options: field.options,
				});
				result.fields.created++;
			}
		}
	}

	// 4-5. Taxonomies
	if (seed.taxonomies) {
		for (const taxonomy of seed.taxonomies) {
			// Check if taxonomy definition exists
			const existingDef = await db
				.selectFrom("_emdash_taxonomy_defs")
				.selectAll()
				.where("name", "=", taxonomy.name)
				.executeTakeFirst();

			if (existingDef) {
				if (onConflict === "error") {
					throw new Error(`Conflict: taxonomy "${taxonomy.name}" already exists`);
				}
				if (onConflict === "update") {
					await db
						.updateTable("_emdash_taxonomy_defs")
						.set({
							label: taxonomy.label,
							label_singular: taxonomy.labelSingular ?? null,
							hierarchical: taxonomy.hierarchical ? 1 : 0,
							collections: JSON.stringify(taxonomy.collections),
						})
						.where("id", "=", existingDef.id)
						.execute();
					// Taxonomy defs don't track an "updated" counter -- just the definition is updated
				}
				// skip: do nothing for the definition
			} else {
				// Create taxonomy definition
				await db
					.insertInto("_emdash_taxonomy_defs")
					.values({
						id: ulid(),
						name: taxonomy.name,
						label: taxonomy.label,
						label_singular: taxonomy.labelSingular ?? null,
						hierarchical: taxonomy.hierarchical ? 1 : 0,
						collections: JSON.stringify(taxonomy.collections),
					})
					.execute();
				result.taxonomies.created++;
			}

			// Create terms (if provided)
			if (taxonomy.terms && taxonomy.terms.length > 0) {
				const termRepo = new TaxonomyRepository(db);

				// For hierarchical taxonomies, we need to create parents before children
				if (taxonomy.hierarchical) {
					await applyHierarchicalTerms(termRepo, taxonomy.name, taxonomy.terms, result, onConflict);
				} else {
					// Flat taxonomy - create all terms
					for (const term of taxonomy.terms) {
						const existing = await termRepo.findBySlug(taxonomy.name, term.slug);
						if (existing) {
							if (onConflict === "error") {
								throw new Error(
									`Conflict: taxonomy term "${term.slug}" in "${taxonomy.name}" already exists`,
								);
							}
							if (onConflict === "update") {
								await termRepo.update(existing.id, {
									label: term.label,
									data: term.description ? { description: term.description } : {},
								});
								result.taxonomies.terms++;
							}
							// skip: do nothing
						} else {
							await termRepo.create({
								name: taxonomy.name,
								slug: term.slug,
								label: term.label,
								data: term.description ? { description: term.description } : undefined,
							});
							result.taxonomies.terms++;
						}
					}
				}
			}
		}
	}

	// 6. Bylines
	if (seed.bylines) {
		const bylineRepo = new BylineRepository(db);
		for (const byline of seed.bylines) {
			const existing = await bylineRepo.findBySlug(byline.slug);
			if (existing) {
				if (onConflict === "error") {
					throw new Error(`Conflict: byline "${byline.slug}" already exists`);
				}

				if (onConflict === "update") {
					await bylineRepo.update(existing.id, {
						displayName: byline.displayName,
						bio: byline.bio ?? null,
						websiteUrl: byline.websiteUrl ?? null,
						isGuest: byline.isGuest,
					});
					seedBylineIdMap.set(byline.id, existing.id);
					result.bylines.updated++;
					continue;
				}

				// skip
				seedBylineIdMap.set(byline.id, existing.id);
				result.bylines.skipped++;
				continue;
			}

			const created = await bylineRepo.create({
				slug: byline.slug,
				displayName: byline.displayName,
				bio: byline.bio ?? null,
				websiteUrl: byline.websiteUrl ?? null,
				isGuest: byline.isGuest,
			});
			seedBylineIdMap.set(byline.id, created.id);
			result.bylines.created++;
		}
	}

	// 7. Content (created before menus so refs can resolve)
	if (includeContent && seed.content) {
		const contentRepo = new ContentRepository(db);

		// Create content entries
		for (const [collectionSlug, entries] of Object.entries(seed.content)) {
			for (const entry of entries) {
				// Check if entry exists (by slug + locale for locale-aware lookup)
				const existing = await contentRepo.findBySlug(collectionSlug, entry.slug, entry.locale);

				if (existing) {
					if (onConflict === "error") {
						throw new Error(
							`Conflict: content "${entry.slug}" in "${collectionSlug}" already exists`,
						);
					}

					if (onConflict === "update") {
						// Resolve $ref and $media in data, then inject _key on any
						// PT-shaped node that's missing one. Keyless seed data is
						// the most common cause of autosave validation failures
						// once a user opens the entry in the admin (#867).
						const resolvedData = normalizePortableTextKeys(
							await resolveReferences(entry.data, seedIdMap, mediaContext, result),
						);

						// Update content + bylines + taxonomies atomically
						const status = entry.status || "published";
						await withTransaction(db, async (trx) => {
							const trxContentRepo = new ContentRepository(trx);
							const trxBylineRepo = new BylineRepository(trx);
							const trxRevisionRepo = new RevisionRepository(trx);

							await trxContentRepo.update(collectionSlug, existing.id, {
								status,
								data: resolvedData,
							});

							await applyContentBylines(
								trxBylineRepo,
								collectionSlug,
								existing.id,
								entry,
								seedBylineIdMap,
								true,
							);
							await applyContentTaxonomies(trx, collectionSlug, existing.id, entry, true);

							// Seed is declarative — when status is "published", promote to a live
							// revision so the admin UI shows "Unpublish" instead of "Save & Publish"
							// and `live_revision_id` is populated for downstream queries.
							//
							// Create a fresh revision from the updated data and stage it as the
							// draft so `publish()` picks it up instead of re-syncing stale data
							// from an existing live revision.
							if (status === "published") {
								const draft = await trxRevisionRepo.create({
									collection: collectionSlug,
									entryId: existing.id,
									data: resolvedData,
								});
								await trxContentRepo.setDraftRevision(collectionSlug, existing.id, draft.id);
								await trxContentRepo.publish(collectionSlug, existing.id);
							}
						});

						seedIdMap.set(entry.id, existing.id);
						result.content.updated++;
						continue;
					}

					// skip
					result.content.skipped++;
					seedIdMap.set(entry.id, existing.id);
					continue;
				}

				// Resolve $ref and $media in data, then inject _key on any
				// PT-shaped node that's missing one. See the matching call
				// in the on-conflict update branch above.
				const resolvedData = normalizePortableTextKeys(
					await resolveReferences(entry.data, seedIdMap, mediaContext, result),
				);

				// Resolve translationOf: map from seed-local ID to real EmDash ID
				let translationOf: string | undefined;
				if (entry.translationOf) {
					const sourceId = seedIdMap.get(entry.translationOf);
					if (!sourceId) {
						console.warn(
							`content.${collectionSlug}: translationOf "${entry.translationOf}" not found (not yet created or missing). Skipping translation link.`,
						);
					} else {
						translationOf = sourceId;
					}
				}

				// Create entry + bylines + taxonomies atomically
				const status = entry.status || "published";
				const created = await withTransaction(db, async (trx) => {
					const trxContentRepo = new ContentRepository(trx);
					const trxBylineRepo = new BylineRepository(trx);

					const item = await trxContentRepo.create({
						type: collectionSlug,
						slug: entry.slug,
						status,
						data: resolvedData,
						locale: entry.locale,
						translationOf,
						publishedAt: status === "published" ? new Date().toISOString() : null,
					});

					await applyContentBylines(trxBylineRepo, collectionSlug, item.id, entry, seedBylineIdMap);
					await applyContentTaxonomies(trx, collectionSlug, item.id, entry, false);

					// Seed is declarative — when status is "published", promote to a live
					// revision so the admin UI shows "Unpublish" instead of "Save & Publish"
					// and `live_revision_id` is populated for downstream queries.
					if (status === "published") {
						await trxContentRepo.publish(collectionSlug, item.id);
					}

					return item;
				});

				seedIdMap.set(entry.id, created.id);
				result.content.created++;
			}
		}
	}

	// 8. Menus and Menu Items (after content so refs can resolve)
	if (seed.menus) {
		for (const menu of seed.menus) {
			// Check if menu exists
			const existingMenu = await db
				.selectFrom("_emdash_menus")
				.selectAll()
				.where("name", "=", menu.name)
				.executeTakeFirst();

			let menuId: string;

			if (existingMenu) {
				menuId = existingMenu.id;
				// Clear existing items (menus are recreated)
				await db.deleteFrom("_emdash_menu_items").where("menu_id", "=", menuId).execute();
			} else {
				// Create menu
				menuId = ulid();
				await db
					.insertInto("_emdash_menus")
					.values({
						id: menuId,
						name: menu.name,
						label: menu.label,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					})
					.execute();
				result.menus.created++;
			}

			// Create menu items
			const itemCount = await applyMenuItems(
				db,
				menuId,
				menu.items,
				null, // parent_id
				0, // sort_order
				seedIdMap,
			);
			result.menus.items += itemCount;
		}
	}

	// 9. Redirects
	if (seed.redirects) {
		const redirectRepo = new RedirectRepository(db);

		for (const redirect of seed.redirects) {
			const existing = await redirectRepo.findBySource(redirect.source);
			if (existing) {
				if (onConflict === "error") {
					throw new Error(`Conflict: redirect "${redirect.source}" already exists`);
				}

				if (onConflict === "update") {
					await redirectRepo.update(existing.id, {
						destination: redirect.destination,
						type: redirect.type,
						enabled: redirect.enabled,
						groupName: redirect.groupName,
					});
					result.redirects.updated++;
					continue;
				}

				// skip
				result.redirects.skipped++;
				continue;
			}

			await redirectRepo.create({
				source: redirect.source,
				destination: redirect.destination,
				type: redirect.type,
				enabled: redirect.enabled,
				groupName: redirect.groupName,
			});
			result.redirects.created++;
		}
	}

	// 10. Widget Areas and Widgets
	if (seed.widgetAreas) {
		for (const area of seed.widgetAreas) {
			// Check if area exists
			const existingArea = await db
				.selectFrom("_emdash_widget_areas")
				.selectAll()
				.where("name", "=", area.name)
				.executeTakeFirst();

			let areaId: string;

			if (existingArea) {
				areaId = existingArea.id;
				// Clear existing widgets (areas are recreated)
				await db.deleteFrom("_emdash_widgets").where("area_id", "=", areaId).execute();
			} else {
				// Create area
				areaId = ulid();
				await db
					.insertInto("_emdash_widget_areas")
					.values({
						id: areaId,
						name: area.name,
						label: area.label,
						description: area.description ?? null,
					})
					.execute();
				result.widgetAreas.created++;
			}

			// Create widgets
			for (let i = 0; i < area.widgets.length; i++) {
				const widget = area.widgets[i];
				await applyWidget(db, areaId, widget, i);
				result.widgetAreas.widgets++;
			}
		}
	}

	// 11. Sections
	if (seed.sections) {
		for (const section of seed.sections) {
			// Sections are reusable PT blobs; normalize keys once up-front so
			// both insert and update branches store schema-valid content (#867).
			const normalizedSectionContent = normalizePortableTextKeys(section.content);

			// Check if section exists
			const existing = await db
				.selectFrom("_emdash_sections")
				.select("id")
				.where("slug", "=", section.slug)
				.executeTakeFirst();

			if (existing) {
				if (onConflict === "error") {
					throw new Error(`Conflict: section "${section.slug}" already exists`);
				}

				if (onConflict === "update") {
					await db
						.updateTable("_emdash_sections")
						.set({
							title: section.title,
							description: section.description ?? null,
							keywords: section.keywords ? JSON.stringify(section.keywords) : null,
							content: JSON.stringify(normalizedSectionContent),
							source: section.source || "theme",
							updated_at: new Date().toISOString(),
						})
						.where("id", "=", existing.id)
						.execute();
					result.sections.updated++;
					continue;
				}

				// skip
				result.sections.skipped++;
				continue;
			}

			const id = ulid();
			const now = new Date().toISOString();

			await db
				.insertInto("_emdash_sections")
				.values({
					id,
					slug: section.slug,
					title: section.title,
					description: section.description ?? null,
					keywords: section.keywords ? JSON.stringify(section.keywords) : null,
					content: JSON.stringify(normalizedSectionContent),
					preview_media_id: null,
					source: section.source || "theme",
					theme_id: section.source === "theme" ? section.slug : null,
					created_at: now,
					updated_at: now,
				})
				.execute();

			result.sections.created++;
		}
	}

	// 11. Enable search for collections that have `search` in supports
	if (seed.collections) {
		const ftsManager = new FTSManager(db);

		for (const collection of seed.collections) {
			if (collection.supports?.includes("search")) {
				// Check if there are searchable fields
				const searchableFields = await ftsManager.getSearchableFields(collection.slug);
				if (searchableFields.length > 0) {
					try {
						await ftsManager.enableSearch(collection.slug);
					} catch (err) {
						// Log but don't fail - search can be enabled manually later
						console.warn(`Failed to enable search for ${collection.slug}:`, err);
					}
				}
			}
		}
	}

	// Invalidate caches that may have been affected by seed data.
	// Seed creates bylines, redirects, and collections, all of which
	// have module-level caches in the hot path.
	const { invalidateBylineCache } = await import("../bylines/index.js");
	const { invalidateRedirectCache } = await import("../redirects/cache.js");
	const { invalidateUrlPatternCache } = await import("../query.js");
	invalidateBylineCache();
	invalidateRedirectCache();
	invalidateUrlPatternCache();

	return result;
}

/**
 * Apply hierarchical taxonomy terms (parents before children)
 */
async function applyHierarchicalTerms(
	termRepo: TaxonomyRepository,
	taxonomyName: string,
	terms: SeedTaxonomyTerm[],
	result: SeedApplyResult,
	onConflict: "skip" | "update" | "error" = "skip",
): Promise<void> {
	// Map slugs to IDs
	const slugToId = new Map<string, string>();

	// Multiple passes to handle deep nesting
	let remaining = [...terms];
	let maxPasses = 10; // Prevent infinite loop

	while (remaining.length > 0 && maxPasses > 0) {
		const processedThisPass: string[] = [];

		for (const term of remaining) {
			// Check if parent exists (or no parent)
			if (!term.parent || slugToId.has(term.parent)) {
				const parentId = term.parent ? slugToId.get(term.parent) : undefined;

				const existing = await termRepo.findBySlug(taxonomyName, term.slug);
				if (existing) {
					if (onConflict === "error") {
						throw new Error(
							`Conflict: taxonomy term "${term.slug}" in "${taxonomyName}" already exists`,
						);
					}
					if (onConflict === "update") {
						await termRepo.update(existing.id, {
							label: term.label,
							parentId,
							data: term.description ? { description: term.description } : {},
						});
						result.taxonomies.terms++;
					}
					slugToId.set(term.slug, existing.id);
				} else {
					const created = await termRepo.create({
						name: taxonomyName,
						slug: term.slug,
						label: term.label,
						parentId,
						data: term.description ? { description: term.description } : undefined,
					});
					slugToId.set(term.slug, created.id);
					result.taxonomies.terms++;
				}

				processedThisPass.push(term.slug);
			}
		}

		// Remove processed terms
		remaining = remaining.filter((t) => !processedThisPass.includes(t.slug));
		maxPasses--;
	}

	if (remaining.length > 0) {
		console.warn(`Could not process ${remaining.length} terms due to missing parents`);
	}
}

/**
 * Apply byline credits to a content entry.
 * In update mode, clears existing credits even if the seed has none.
 */
async function applyContentBylines(
	bylineRepo: BylineRepository,
	collectionSlug: string,
	contentId: string,
	entry: { slug: string; bylines?: Array<{ byline: string; roleLabel?: string }> },
	seedBylineIdMap: Map<string, string>,
	isUpdate = false,
): Promise<void> {
	if (!entry.bylines || entry.bylines.length === 0) {
		// In update mode, clear existing bylines when the seed entry has none
		if (isUpdate) {
			await bylineRepo.setContentBylines(collectionSlug, contentId, []);
		}
		return;
	}

	const credits = entry.bylines
		.map((credit) => {
			const bylineId = seedBylineIdMap.get(credit.byline);
			if (!bylineId) return null;
			return {
				bylineId,
				roleLabel: credit.roleLabel ?? null,
			};
		})
		.filter((credit): credit is { bylineId: string; roleLabel: string | null } => Boolean(credit));

	if (credits.length !== entry.bylines.length) {
		console.warn(
			`content.${collectionSlug}.${entry.slug}: one or more byline refs could not be resolved`,
		);
	}

	// In update mode, always call setContentBylines (even with empty credits)
	// to clear stale assignments when all byline refs fail to resolve.
	// In create mode, only call if there are credits to assign.
	if (credits.length > 0 || isUpdate) {
		await bylineRepo.setContentBylines(collectionSlug, contentId, credits);
	}
}

/**
 * Apply taxonomy term assignments to a content entry.
 * In update mode, clears existing assignments before re-attaching.
 */
async function applyContentTaxonomies(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
	entry: { taxonomies?: Record<string, string[]> },
	isUpdate: boolean,
): Promise<void> {
	// In update mode, clear existing taxonomy assignments first
	if (isUpdate) {
		await db
			.deleteFrom("content_taxonomies")
			.where("collection", "=", collectionSlug)
			.where("entry_id", "=", contentId)
			.execute();
	}

	if (!entry.taxonomies) {
		// In update mode we may have just deleted rows above; invalidate so
		// hydration doesn't serve stale "has terms" cached value.
		if (isUpdate) {
			const { invalidateTermCache } = await import("../taxonomies/index.js");
			invalidateTermCache();
		}
		return;
	}

	for (const [taxonomyName, termSlugs] of Object.entries(entry.taxonomies)) {
		const termRepo = new TaxonomyRepository(db);

		for (const termSlug of termSlugs) {
			const term = await termRepo.findBySlug(taxonomyName, termSlug);
			if (term) {
				await termRepo.attachToEntry(collectionSlug, contentId, term.id);
			}
		}
	}

	// Seed writes directly to content_taxonomies. Clear the cache so
	// the worker lifetime cached "has any term assignments" probe
	// re-runs on the next read.
	const { invalidateTermCache } = await import("../taxonomies/index.js");
	invalidateTermCache();
}

/**
 * Apply menu items recursively
 */
async function applyMenuItems(
	db: Kysely<Database>,
	menuId: string,
	items: SeedMenuItem[],
	parentId: string | null,
	startOrder: number,
	seedIdMap: Map<string, string>,
): Promise<number> {
	let count = 0;
	let order = startOrder;

	for (const item of items) {
		const itemId = ulid();

		// Resolve reference if needed
		let referenceId: string | null = null;
		let referenceCollection: string | null = null;

		if (item.type === "page" || item.type === "post") {
			// Try to resolve from seedIdMap
			if (item.ref && seedIdMap.has(item.ref)) {
				referenceId = seedIdMap.get(item.ref)!;
				// Default to plural collection name (pages/posts) if not specified
				referenceCollection = item.collection || `${item.type}s`;
			}
			// If not in map, the content might not exist yet (will be broken link)
		}

		// Insert menu item
		await db
			.insertInto("_emdash_menu_items")
			.values({
				id: itemId,
				menu_id: menuId,
				parent_id: parentId,
				sort_order: order,
				type: item.type,
				reference_collection: referenceCollection,
				reference_id: referenceId,
				custom_url: item.url ?? null,
				label: item.label || "",
				title_attr: item.titleAttr ?? null,
				target: item.target ?? null,
				css_classes: item.cssClasses ?? null,
				created_at: new Date().toISOString(),
			})
			.execute();

		count++;
		order++;

		// Process children
		if (item.children && item.children.length > 0) {
			const childCount = await applyMenuItems(db, menuId, item.children, itemId, 0, seedIdMap);
			count += childCount;
		}
	}

	return count;
}

/**
 * Apply a widget
 */
async function applyWidget(
	db: Kysely<Database>,
	areaId: string,
	widget: SeedWidget,
	sortOrder: number,
): Promise<void> {
	await db
		.insertInto("_emdash_widgets")
		.values({
			id: ulid(),
			area_id: areaId,
			sort_order: sortOrder,
			type: widget.type,
			title: widget.title ?? null,
			// Normalize PT keys (#867). `widget.content` is Portable Text for
			// content-type widgets; for other widget kinds it's null.
			content: widget.content ? JSON.stringify(normalizePortableTextKeys(widget.content)) : null,
			menu_name: widget.menuName ?? null,
			component_id: widget.componentId ?? null,
			component_props: widget.props ? JSON.stringify(widget.props) : null,
		})
		.execute();
}

/**
 * Context for media resolution during seed application
 */
interface MediaContext {
	db: Kysely<Database>;
	storage: Storage | null;
	skipMediaDownload: boolean;
	mediaCache: Map<string, MediaValue>; // URL -> resolved MediaValue
}

/**
 * Type guard for $media reference
 */
function isSeedMediaReference(value: unknown): value is SeedMediaReference {
	if (typeof value !== "object" || value === null || !("$media" in value)) {
		return false;
	}
	const media = (value as Record<string, unknown>).$media;
	return (
		typeof media === "object" &&
		media !== null &&
		"url" in media &&
		typeof (media as Record<string, unknown>).url === "string"
	);
}

/**
 * Resolve $ref: and $media references in content data
 */
async function resolveReferences(
	data: Record<string, unknown>,
	seedIdMap: Map<string, string>,
	mediaContext: MediaContext,
	result: SeedApplyResult,
): Promise<Record<string, unknown>> {
	const resolved: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(data)) {
		resolved[key] = await resolveValue(value, seedIdMap, mediaContext, result);
	}

	return resolved;
}

/**
 * Resolve a single value recursively
 */
async function resolveValue(
	value: unknown,
	seedIdMap: Map<string, string>,
	mediaContext: MediaContext,
	result: SeedApplyResult,
): Promise<unknown> {
	// Handle $ref: syntax
	if (typeof value === "string" && value.startsWith("$ref:")) {
		const seedId = value.slice(5);
		return seedIdMap.get(seedId) ?? value; // Return unresolved if not found
	}

	// Handle $media syntax
	if (isSeedMediaReference(value)) {
		return resolveMedia(value, mediaContext, result);
	}

	// Handle arrays
	if (Array.isArray(value)) {
		return Promise.all(value.map((item) => resolveValue(item, seedIdMap, mediaContext, result)));
	}

	// Handle objects recursively
	if (typeof value === "object" && value !== null) {
		const resolved: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			resolved[k] = await resolveValue(v, seedIdMap, mediaContext, result);
		}
		return resolved;
	}

	return value;
}

/**
 * Resolve a $media reference by downloading and uploading the media
 */
async function resolveMedia(
	ref: SeedMediaReference,
	ctx: MediaContext,
	result: SeedApplyResult,
): Promise<MediaValue | null> {
	const { url, alt, filename, caption } = ref.$media;

	// Check cache first
	const cached = ctx.mediaCache.get(url);
	if (cached) {
		result.media.skipped++;
		return { ...cached, alt: alt ?? cached.alt };
	}

	// When skipMediaDownload is set, resolve $media to an external URL reference
	// without downloading or storing anything. Used by playground mode.
	if (ctx.skipMediaDownload) {
		const mediaValue: MediaValue = {
			provider: "external",
			id: ulid(),
			src: url,
			alt: alt ?? undefined,
			filename: filename ?? undefined,
		};
		ctx.mediaCache.set(url, mediaValue);
		result.media.created++;
		return mediaValue;
	}

	// Storage is required for $media resolution
	if (!ctx.storage) {
		console.warn(`Skipping $media reference (no storage configured): ${url}`);
		result.media.skipped++;
		return null;
	}

	try {
		// SSRF protection: validate URL before downloading
		validateExternalUrl(url);

		// Download the media (ssrfSafeFetch re-validates redirect targets)
		console.log(`  📥 Downloading: ${url}`);
		const response = await ssrfSafeFetch(url, {
			headers: {
				// Some services like Unsplash require a user-agent
				"User-Agent": "EmDash-CMS/1.0",
			},
		});

		if (!response.ok) {
			console.warn(`  ⚠️ Failed to download ${url}: ${response.status}`);
			result.media.skipped++;
			return null;
		}

		// Get content type and determine extension
		const contentType = response.headers.get("content-type") || "application/octet-stream";
		const ext = getExtensionFromContentType(contentType) || getExtensionFromUrl(url) || ".bin";

		// Generate filename and storage key
		const id = ulid();
		const finalFilename = filename || generateFilename(url, ext);
		const storageKey = `${id}${ext}`;

		// Get the body as buffer
		const arrayBuffer = await response.arrayBuffer();
		const body = new Uint8Array(arrayBuffer);

		// Get image dimensions if it's an image
		let width: number | undefined;
		let height: number | undefined;
		if (contentType.startsWith("image/")) {
			const dimensions = getImageDimensions(body);
			width = dimensions?.width;
			height = dimensions?.height;
		}

		// Upload to storage
		await ctx.storage.upload({
			key: storageKey,
			body,
			contentType,
		});

		// Create media record
		const mediaRepo = new MediaRepository(ctx.db);
		await mediaRepo.create({
			filename: finalFilename,
			mimeType: contentType,
			size: body.length,
			width,
			height,
			alt,
			caption,
			storageKey,
			status: "ready",
		});

		// Create the MediaValue - only store id, URL is built at runtime by EmDashMedia
		const mediaValue: MediaValue = {
			provider: "local",
			id,
			alt: alt ?? undefined,
			width,
			height,
			mimeType: contentType,
			filename: finalFilename,
			meta: { storageKey },
		};

		// Cache for reuse
		ctx.mediaCache.set(url, mediaValue);
		result.media.created++;

		console.log(`  ✅ Uploaded: ${finalFilename}`);
		return mediaValue;
	} catch (error) {
		console.warn(
			`  ⚠️ Error processing $media ${url}:`,
			error instanceof Error ? error.message : error,
		);
		result.media.skipped++;
		return null;
	}
}

/**
 * Get file extension from content type
 */
function getExtensionFromContentType(contentType: string): string | null {
	// Handle content-type with parameters like "image/jpeg; charset=utf-8"
	const baseMime = contentType.split(";")[0].trim();
	const ext = mime.getExtension(baseMime);
	return ext ? `.${ext}` : null;
}

/**
 * Get file extension from URL
 */
function getExtensionFromUrl(url: string): string | null {
	try {
		const pathname = new URL(url).pathname;
		const match = pathname.match(FILE_EXTENSION_PATTERN);
		return match ? `.${match[1]}` : null;
	} catch {
		return null;
	}
}

/**
 * Generate a filename from URL
 */
function generateFilename(url: string, ext: string): string {
	try {
		const pathname = new URL(url).pathname;
		const basename = pathname.split("/").pop() || "media";
		// Remove any existing extension and query params
		const name = basename.replace(EXTENSION_PATTERN, "").replace(QUERY_PARAM_PATTERN, "");
		// Sanitize: only alphanumeric, dash, underscore
		const sanitized = name.replace(SANITIZE_PATTERN, "-").replace(MULTIPLE_HYPHENS_PATTERN, "-");
		return `${sanitized || "media"}${ext}`;
	} catch {
		return `media${ext}`;
	}
}

/**
 * Get image dimensions from buffer using image-size.
 * Supports PNG, JPEG, GIF, WebP, AVIF, SVG, TIFF, and more.
 */
function getImageDimensions(buffer: Uint8Array): { width: number; height: number } | null {
	try {
		const result = imageSize(buffer);
		if (result.width != null && result.height != null) {
			return { width: result.width, height: result.height };
		}
		return null;
	} catch {
		return null;
	}
}
