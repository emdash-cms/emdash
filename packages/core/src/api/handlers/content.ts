/**
 * Content CRUD handlers
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { BylineRepository } from "../../database/repositories/byline.js";
import type { ContentBylineInput } from "../../database/repositories/byline.js";
import { CommentRepository } from "../../database/repositories/comment.js";
import { ContentRepository } from "../../database/repositories/content.js";
import { RedirectRepository } from "../../database/repositories/redirect.js";
import { RevisionRepository } from "../../database/repositories/revision.js";
import { SeoRepository } from "../../database/repositories/seo.js";
import {
	EmDashValidationError,
	InvalidCursorError,
	type ContentItem,
	type ContentSeo,
	type ContentSeoInput,
} from "../../database/repositories/types.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { isI18nEnabled } from "../../i18n/config.js";
import { invalidateRedirectCache } from "../../redirects/cache.js";
import { invalidateTermCache } from "../../taxonomies/index.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { encodeRev, validateRev } from "../rev.js";
import type { ApiResult, ContentListResponse, ContentResponse } from "../types.js";

/**
 * Narrow a caught error to one carrying a structured `apiError` discriminant.
 * Used by transaction callbacks that want to surface a specific error code
 * through the standard Error throwing path.
 */
function hasApiError(error: unknown): error is Error & { apiError: { code: string } } {
	if (!(error instanceof Error) || !("apiError" in error)) return false;
	const { apiError } = error;
	return (
		typeof apiError === "object" &&
		apiError !== null &&
		"code" in apiError &&
		typeof apiError.code === "string"
	);
}

/**
 * Extract a slug source (title or name) from content data.
 * Returns null if no suitable string field is found.
 */
function getSlugSource(data: Record<string, unknown>): string | null {
	if (typeof data.title === "string" && data.title.length > 0) return data.title;
	if (typeof data.name === "string" && data.name.length > 0) return data.name;
	return null;
}

/** Default SEO values for content without an explicit SEO row */
const SEO_DEFAULTS: ContentSeo = {
	title: null,
	description: null,
	image: null,
	canonical: null,
	noIndex: false,
};

/**
 * Check if a collection has SEO enabled.
 */
async function collectionHasSeo(db: Kysely<Database>, collection: string): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select("has_seo")
		.where("slug", "=", collection)
		.executeTakeFirst();
	return row?.has_seo === 1;
}

/**
 * Hydrate SEO data on a single content item if the collection has SEO enabled.
 */
async function hydrateSeo(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
	hasSeo: boolean,
): Promise<void> {
	if (!hasSeo) return;
	const seoRepo = new SeoRepository(db);
	item.seo = await seoRepo.get(collection, item.id);
}

/**
 * Hydrate SEO data on multiple content items using a single batch query.
 */
async function hydrateSeoMany(
	db: Kysely<Database>,
	collection: string,
	items: ContentItem[],
	hasSeo: boolean,
): Promise<void> {
	if (!hasSeo || items.length === 0) return;
	const seoRepo = new SeoRepository(db);
	const seoMap = await seoRepo.getMany(
		collection,
		items.map((i) => i.id),
	);
	for (const item of items) {
		item.seo = seoMap.get(item.id) ?? { ...SEO_DEFAULTS };
	}
}

async function hydrateBylines(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
): Promise<void> {
	const bylineRepo = new BylineRepository(db);
	const bylines = await bylineRepo.getContentBylines(collection, item.id);

	if (bylines.length > 0) {
		item.bylines = bylines.map((c) => ({ ...c, source: "explicit" as const }));
		item.byline = bylines[0]?.byline ?? null;
		return;
	}

	// Defensive: if primaryBylineId is set but no junction rows exist, it's orphaned
	if (item.primaryBylineId) {
		item.primaryBylineId = null;
	}

	if (item.authorId) {
		const fallback = await bylineRepo.findByUserId(item.authorId);
		if (fallback) {
			item.bylines = [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }];
			item.byline = fallback;
			return;
		}
	}

	item.bylines = [];
	item.byline = null;
}

/**
 * Batch-hydrate bylines for multiple items using two bulk queries instead of N+1.
 */
async function hydrateBylinesMany(
	db: Kysely<Database>,
	collection: string,
	items: ContentItem[],
): Promise<void> {
	if (items.length === 0) return;

	const bylineRepo = new BylineRepository(db);

	// 1. Batch fetch all explicit byline credits
	const contentIds = items.map((i) => i.id);
	const bylinesMap = await bylineRepo.getContentBylinesMany(collection, contentIds);

	// 2. Collect authorIds that need fallback lookup
	const fallbackAuthorIds: string[] = [];
	for (const item of items) {
		if (!bylinesMap.has(item.id) && item.authorId) {
			fallbackAuthorIds.push(item.authorId);
		}
	}

	// 3. Batch fetch user-linked bylines for fallback
	const uniqueAuthorIds = [...new Set(fallbackAuthorIds)];
	const authorBylineMap = await bylineRepo.findByUserIds(uniqueAuthorIds);

	// 4. Assign to each item
	for (const item of items) {
		const explicit = bylinesMap.get(item.id);
		if (explicit && explicit.length > 0) {
			item.bylines = explicit.map((c) => ({ ...c, source: "explicit" as const }));
			item.byline = explicit[0]?.byline ?? null;
			continue;
		}

		// Defensive: if primaryBylineId is set but no junction rows exist, it's orphaned
		if (item.primaryBylineId) {
			item.primaryBylineId = null;
		}

		if (item.authorId) {
			const fallback = authorBylineMap.get(item.authorId);
			if (fallback) {
				item.bylines = [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }];
				item.byline = fallback;
				continue;
			}
		}

		item.bylines = [];
		item.byline = null;
	}
}

/**
 * Resolve an identifier (ID or slug) to a real content ID.
 * Returns the ID if found, null if not found.
 * When locale is provided, slug lookups are scoped to that locale.
 */
async function resolveId(
	repo: ContentRepository,
	collection: string,
	identifier: string,
	locale?: string,
): Promise<string | null> {
	const item = await repo.findByIdOrSlug(collection, identifier, locale);
	return item?.id ?? null;
}

/**
 * Resolve an identifier (ID or slug) to a real content ID,
 * including trashed (soft-deleted) items.
 */
async function resolveIdIncludingTrashed(
	repo: ContentRepository,
	collection: string,
	identifier: string,
	locale?: string,
): Promise<string | null> {
	const item = await repo.findByIdOrSlugIncludingTrashed(collection, identifier, locale);
	return item?.id ?? null;
}

/**
 * Trashed content item with deletion timestamp
 */
export interface TrashedContentItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	authorId: string | null;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	deletedAt: string;
}

/**
 * Create content list handler
 */
export async function handleContentList(
	db: Kysely<Database>,
	collection: string,
	params: {
		cursor?: string;
		limit?: number;
		status?: string;
		orderBy?: string;
		order?: "asc" | "desc";
		locale?: string;
	},
): Promise<ApiResult<ContentListResponse>> {
	try {
		const repo = new ContentRepository(db);
		const where: { status?: string; locale?: string } = {};
		if (params.status) where.status = params.status;
		if (params.locale) where.locale = params.locale;

		const result = await repo.findMany(collection, {
			cursor: params.cursor,
			limit: params.limit || 50,
			where: Object.keys(where).length > 0 ? where : undefined,
			orderBy: params.orderBy
				? { field: params.orderBy, direction: params.order || "desc" }
				: undefined,
		});

		// Hydrate SEO data if the collection has SEO enabled
		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeoMany(db, collection, result.items, hasSeo);
		await hydrateBylinesMany(db, collection, result.items);

		return {
			success: true,
			data: {
				items: result.items,
				nextCursor: result.nextCursor,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		if (isMissingTableError(error)) {
			return {
				success: false,
				error: {
					code: "COLLECTION_NOT_FOUND",
					message: `Collection '${collection}' not found`,
				},
			};
		}
		if (error instanceof EmDashValidationError) {
			// e.g. invalid orderBy field
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		console.error("Content list error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_LIST_ERROR",
				message: "Failed to list content",
			},
		};
	}
}

/**
 * Get single content item
 */
export async function handleContentGet(
	db: Kysely<Database>,
	collection: string,
	id: string,
	locale?: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const repo = new ContentRepository(db);
		const item = await repo.findByIdOrSlug(collection, id, locale);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		// Hydrate SEO data if the collection has SEO enabled
		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);
		await hydrateBylines(db, collection, item);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		console.error("Content get error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_GET_ERROR",
				message: "Failed to get content",
			},
		};
	}
}

/**
 * Get a content item by id, including trashed items.
 * Used by restore endpoint for ownership checks on soft-deleted items.
 */
export async function handleContentGetIncludingTrashed(
	db: Kysely<Database>,
	collection: string,
	id: string,
	locale?: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const repo = new ContentRepository(db);
		const item = await repo.findByIdOrSlugIncludingTrashed(collection, id, locale);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		// Hydrate SEO data if the collection has SEO enabled
		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);
		await hydrateBylines(db, collection, item);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		console.error("Content get error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_GET_ERROR",
				message: "Failed to get content",
			},
		};
	}
}

/**
 * Create content item.
 *
 * Content + SEO writes are wrapped in a transaction so either both succeed
 * or neither does. If `body.seo` is provided for a non-SEO collection, the
 * API returns a validation error rather than silently dropping it.
 */
export async function handleContentCreate(
	db: Kysely<Database>,
	collection: string,
	body: {
		data: Record<string, unknown>;
		slug?: string;
		status?: string;
		authorId?: string;
		bylines?: ContentBylineInput[];
		locale?: string;
		translationOf?: string;
		seo?: ContentSeoInput;
		createdAt?: string | null;
		publishedAt?: string | null;
	},
): Promise<ApiResult<ContentResponse>> {
	try {
		const hasSeo = await collectionHasSeo(db, collection);

		// Reject SEO input for non-SEO collections
		if (body.seo && !hasSeo) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `Collection "${collection}" does not have SEO enabled. Remove the seo field or enable SEO on this collection.`,
				},
			};
		}

		// Wrap content + SEO writes in a transaction for atomicity
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);

			// Auto-generate slug from title/name if not explicitly provided
			let slug: string | null | undefined = body.slug;
			if (!slug) {
				const slugSource = getSlugSource(body.data);
				if (slugSource) {
					slug = await repo.generateUniqueSlug(collection, slugSource, body.locale);
				}
			}

			const created = await repo.create({
				type: collection,
				slug,
				data: body.data,
				status: body.status || "draft",
				authorId: body.authorId,
				locale: body.locale,
				translationOf: body.translationOf,
				createdAt: body.createdAt,
				publishedAt: body.publishedAt,
			});

			if (body.bylines !== undefined) {
				await bylineRepo.setContentBylines(collection, created.id, body.bylines);
				created.primaryBylineId = body.bylines[0]?.bylineId ?? null;
			}
			await hydrateBylines(trx, collection, created);

			// Side-write SEO data if provided
			if (body.seo && hasSeo) {
				const seoRepo = new SeoRepository(trx);
				created.seo = await seoRepo.upsert(collection, created.id, body.seo);
			} else if (hasSeo) {
				// Assign defaults in-memory — no DB round-trip needed
				created.seo = { ...SEO_DEFAULTS };
			}

			return created;
		});

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		if (isMissingTableError(error)) {
			return {
				success: false,
				error: {
					code: "COLLECTION_NOT_FOUND",
					message: `Collection '${collection}' not found`,
				},
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		// SQLite UNIQUE constraint OR Postgres unique_violation — slug
		// collisions and any other unique violations land here. Match
		// specifically on "unique constraint failed" / "duplicate key" so we
		// don't false-positive on NOT NULL or CHECK violations whose
		// messages also contain "constraint failed".
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (message.includes("unique constraint failed") || message.includes("duplicate key")) {
			// Detect slug-specific collisions by message fingerprint
			if (message.includes("slug")) {
				return {
					success: false,
					error: {
						code: "SLUG_CONFLICT",
						message: `Slug '${body.slug ?? "(auto-generated)"}' already exists in collection '${collection}'`,
					},
				};
			}
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: "Unique constraint violation",
				},
			};
		}
		console.error("Content create error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_CREATE_ERROR",
				message: "Failed to create content",
			},
		};
	}
}

/**
 * Update content item.
 * If `_rev` is provided, validates it against the current version before writing.
 * No `_rev` = blind write (backwards-compatible for admin UI).
 *
 * Content + SEO writes are wrapped in a transaction for atomicity.
 */
export async function handleContentUpdate(
	db: Kysely<Database>,
	collection: string,
	id: string,
	body: {
		data?: Record<string, unknown>;
		slug?: string;
		status?: string;
		authorId?: string | null;
		bylines?: ContentBylineInput[];
		_rev?: string;
		seo?: ContentSeoInput;
		publishedAt?: string | null;
	},
): Promise<ApiResult<ContentResponse>> {
	try {
		const hasSeo = await collectionHasSeo(db, collection);

		// Reject SEO input for non-SEO collections
		if (body.seo && !hasSeo) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `Collection "${collection}" does not have SEO enabled. Remove the seo field or enable SEO on this collection.`,
				},
			};
		}

		const repo = new ContentRepository(db);

		// Resolve slug → ID if needed
		const resolvedId = (await resolveId(repo, collection, id)) ?? id;

		// Wrap content + SEO writes in a transaction for atomicity.
		// The _rev check is inside the transaction so the read-then-write
		// is atomic -- no concurrent write can slip between the check and update.
		const item = await withTransaction(db, async (trx) => {
			const trxRepo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);

			// Read existing item once for both _rev check and old slug capture
			const existing =
				body._rev || body.slug ? await trxRepo.findById(collection, resolvedId) : null;

			// Validate _rev if provided (optimistic concurrency)
			if (body._rev) {
				if (!existing) {
					throw Object.assign(new Error(`Content item not found: ${id}`), {
						apiError: { code: "NOT_FOUND" as const },
					});
				}

				const revCheck = validateRev(body._rev, existing);
				if (!revCheck.valid) {
					throw Object.assign(new Error(revCheck.message), {
						apiError: { code: "CONFLICT" as const },
					});
				}
			}

			// Capture old slug before update for auto-redirect
			let oldSlug: string | undefined;
			if (body.slug && existing?.slug && existing.slug !== body.slug) {
				oldSlug = existing.slug;
			}

			const updated = await trxRepo.update(collection, resolvedId, {
				data: body.data,
				slug: body.slug,
				status: body.status,
				authorId: body.authorId,
				publishedAt: body.publishedAt,
			});

			if (body.bylines !== undefined) {
				await bylineRepo.setContentBylines(collection, resolvedId, body.bylines);
				updated.primaryBylineId = body.bylines[0]?.bylineId ?? null;
			}

			// Create auto-redirect when slug changes
			if (oldSlug && body.slug) {
				const collectionRow = await trx
					.selectFrom("_emdash_collections")
					.select("url_pattern")
					.where("slug", "=", collection)
					.executeTakeFirst();

				const redirectRepo = new RedirectRepository(trx);
				await redirectRepo.createAutoRedirect(
					collection,
					oldSlug,
					body.slug,
					resolvedId,
					collectionRow?.url_pattern ?? null,
				);
				invalidateRedirectCache();
			}

			// Sync non-translatable fields to sibling locales in the same
			// translation group. Only runs when i18n is enabled, data was updated,
			// and the item belongs to a translation group with siblings.
			if (isI18nEnabled() && body.data && updated.translationGroup) {
				await syncNonTranslatableFields(
					trx,
					collection,
					updated.id,
					updated.translationGroup,
					body.data,
				);
			}

			// Side-write SEO data if provided, always hydrate for SEO-enabled collections
			if (body.seo && hasSeo) {
				const seoRepo = new SeoRepository(trx);
				updated.seo = await seoRepo.upsert(collection, resolvedId, body.seo);
			} else if (hasSeo) {
				const seoRepo = new SeoRepository(trx);
				updated.seo = await seoRepo.get(collection, resolvedId);
			}

			await hydrateBylines(trx, collection, updated);

			return updated;
		});

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		// Handle structured errors thrown from inside the transaction
		// (rev check failures, not-found)
		if (hasApiError(error)) {
			return {
				success: false,
				error: { code: error.apiError.code, message: error.message },
			};
		}
		if (isMissingTableError(error)) {
			return {
				success: false,
				error: {
					code: "COLLECTION_NOT_FOUND",
					message: `Collection '${collection}' not found`,
				},
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (message.includes("unique constraint failed") || message.includes("duplicate key")) {
			if (message.includes("slug")) {
				return {
					success: false,
					error: {
						code: "SLUG_CONFLICT",
						message: `Slug '${body.slug ?? id}' already exists in collection '${collection}'`,
					},
				};
			}
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: "Unique constraint violation",
				},
			};
		}
		console.error("Content update error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_UPDATE_ERROR",
				message: "Failed to update content",
			},
		};
	}
}

/**
 * Duplicate content item.
 *
 * Only copies SEO data if the collection has SEO enabled.
 * Always returns consistent `seo` shape for SEO-enabled collections.
 */
export async function handleContentDuplicate(
	db: Kysely<Database>,
	collection: string,
	id: string,
	authorId?: string,
): Promise<ApiResult<{ item: ContentItem }>> {
	try {
		const hasSeo = await collectionHasSeo(db, collection);

		// Wrap duplicate + SEO copy in a transaction for atomicity
		const duplicate = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			const dup = await repo.duplicate(collection, resolvedId, authorId);

			const existingBylines = await bylineRepo.getContentBylines(collection, resolvedId);
			if (existingBylines.length > 0) {
				await bylineRepo.setContentBylines(
					collection,
					dup.id,
					existingBylines.map((entry) => ({
						bylineId: entry.byline.id,
						roleLabel: entry.roleLabel,
					})),
				);
			}

			if (hasSeo) {
				// Copy SEO data from the original (clears canonical)
				const seoRepo = new SeoRepository(trx);
				await seoRepo.copyForDuplicate(collection, resolvedId, dup.id);
				// Always hydrate SEO for consistent response shape
				dup.seo = await seoRepo.get(collection, dup.id);
			}

			await hydrateBylines(trx, collection, dup);

			return dup;
		});

		return {
			success: true,
			data: { item: duplicate },
		};
	} catch (err) {
		if (err instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: err.message,
				},
			};
		}
		console.error("Content duplicate error:", err);
		return {
			success: false,
			error: {
				code: "CONTENT_DUPLICATE_ERROR",
				message: "Failed to duplicate content",
			},
		};
	}
}

/**
 * Delete content item (soft delete - moves to trash)
 */
export async function handleContentDelete(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const deleted = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.delete(collection, resolvedId);
		});

		if (!deleted) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		// Trashed entries are excluded from public counts (#581).
		invalidateTermCache();

		return {
			success: true,
			data: { deleted: true },
		};
	} catch (error) {
		console.error("Content delete error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_DELETE_ERROR",
				message: "Failed to delete content",
			},
		};
	}
}

/**
 * Restore content item from trash
 */
export async function handleContentRestore(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<{ restored: true }>> {
	try {
		const restored = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveIdIncludingTrashed(repo, collection, id)) ?? id;
			return repo.restore(collection, resolvedId);
		});

		if (!restored) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Trashed content item not found: ${id}`,
				},
			};
		}

		// Restored entry may now appear in public counts again (#581).
		invalidateTermCache();

		return {
			success: true,
			data: { restored: true },
		};
	} catch (error) {
		console.error("Content restore error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_RESTORE_ERROR",
				message: "Failed to restore content",
			},
		};
	}
}

/**
 * Permanently delete content item (cannot be undone).
 * Also cleans up associated SEO data.
 */
export async function handleContentPermanentDelete(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const repo = new ContentRepository(db);
		const resolvedId = (await resolveIdIncludingTrashed(repo, collection, id)) ?? id;

		// Wrap content delete + SEO/comment cleanup in a transaction
		const deleted = await withTransaction(db, async (trx) => {
			const trxRepo = new ContentRepository(trx);
			const wasDeleted = await trxRepo.permanentDelete(collection, resolvedId);

			if (wasDeleted) {
				// Clean up SEO data for permanently deleted content
				const seoRepo = new SeoRepository(trx);
				await seoRepo.delete(collection, resolvedId);
				// Clean up comments for permanently deleted content
				const commentRepo = new CommentRepository(trx);
				await commentRepo.deleteByContent(collection, resolvedId);
				// Clean up revisions for permanently deleted content
				const revisionRepo = new RevisionRepository(trx);
				await revisionRepo.deleteByEntry(collection, resolvedId);
			}

			return wasDeleted;
		});

		if (!deleted) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		// Row is gone (and so are its content_taxonomies via FK), drop
		// any cached counts that may have included it (#581).
		invalidateTermCache();

		return {
			success: true,
			data: { deleted: true },
		};
	} catch (error) {
		console.error("Content permanent delete error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_DELETE_ERROR",
				message: "Failed to permanently delete content",
			},
		};
	}
}

/**
 * List trashed content items
 */
export async function handleContentListTrashed(
	db: Kysely<Database>,
	collection: string,
	options: { limit?: number; cursor?: string } = {},
): Promise<ApiResult<{ items: TrashedContentItem[]; nextCursor?: string }>> {
	try {
		const repo = new ContentRepository(db);
		const result = await repo.findTrashed(collection, {
			limit: options.limit,
			cursor: options.cursor,
		});

		return {
			success: true,
			data: {
				items: result.items.map((item) => ({
					id: item.id,
					type: item.type,
					slug: item.slug,
					status: item.status,
					data: item.data,
					authorId: item.authorId,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					publishedAt: item.publishedAt,
					deletedAt: item.deletedAt,
				})),
				nextCursor: result.nextCursor,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		console.error("Content list trashed error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_LIST_ERROR",
				message: "Failed to list trashed content",
			},
		};
	}
}

/**
 * Count trashed content items
 */
export async function handleContentCountTrashed(
	db: Kysely<Database>,
	collection: string,
): Promise<ApiResult<{ count: number }>> {
	try {
		const repo = new ContentRepository(db);
		const count = await repo.countTrashed(collection);

		return {
			success: true,
			data: { count },
		};
	} catch (error) {
		console.error("Content count trashed error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_COUNT_ERROR",
				message: "Failed to count trashed content",
			},
		};
	}
}

/**
 * Schedule content for future publishing
 */
export async function handleContentSchedule(
	db: Kysely<Database>,
	collection: string,
	id: string,
	scheduledAt: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.schedule(collection, resolvedId, scheduledAt);
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		console.error("Content schedule error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_SCHEDULE_ERROR",
				message: "Failed to schedule content",
			},
		};
	}
}

/**
 * Unschedule content (revert to draft)
 */
export async function handleContentUnschedule(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.unschedule(collection, resolvedId);
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		console.error("Content unschedule error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_UNSCHEDULE_ERROR",
				message: "Failed to unschedule content",
			},
		};
	}
}

/**
 * Publish content immediately.
 *
 * Wrapped in a transaction because publish performs multiple writes
 * (syncDataColumns, slug sync, status/revision update) that must
 * be atomic to prevent FTS shadow table corruption on crash.
 */
export async function handleContentPublish(
	db: Kysely<Database>,
	collection: string,
	id: string,
	options: { publishedAt?: string } = {},
): Promise<ApiResult<ContentResponse>> {
	try {
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.publish(collection, resolvedId, options.publishedAt);
		});

		// Drop the worker-lifetime term-counts cache so taxonomy widgets
		// reflect the new published entry on the next read (#581).
		invalidateTermCache();

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		console.error("Content publish error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_PUBLISH_ERROR",
				message: "Failed to publish content",
			},
		};
	}
}

/**
 * Unpublish content (revert to draft).
 *
 * Wrapped in a transaction — unpublish may create a draft revision
 * from the live version then update the status, which is multi-step.
 */
export async function handleContentUnpublish(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.unpublish(collection, resolvedId);
		});

		// Drop the worker-lifetime term-counts cache so taxonomy widgets
		// stop counting the entry on the next read (#581).
		invalidateTermCache();

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		console.error("Content unpublish error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_UNPUBLISH_ERROR",
				message: "Failed to unpublish content",
			},
		};
	}
}

/**
 * Count scheduled content items
 */
export async function handleContentCountScheduled(
	db: Kysely<Database>,
	collection: string,
): Promise<ApiResult<{ count: number }>> {
	try {
		const repo = new ContentRepository(db);
		const count = await repo.countScheduled(collection);

		return {
			success: true,
			data: { count },
		};
	} catch (error) {
		console.error("Content count scheduled error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_COUNT_ERROR",
				message: "Failed to count scheduled content",
			},
		};
	}
}

/**
 * Discard draft changes (revert to live version)
 */
export async function handleContentDiscardDraft(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.discardDraft(collection, resolvedId);
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: error.message,
				},
			};
		}
		console.error("Content discard draft error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_DISCARD_DRAFT_ERROR",
				message: "Failed to discard draft",
			},
		};
	}
}

/**
 * Compare live and draft revisions
 */
export async function handleContentCompare(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<
	ApiResult<{
		hasChanges: boolean;
		live: Record<string, unknown> | null;
		draft: Record<string, unknown> | null;
	}>
> {
	try {
		const repo = new ContentRepository(db);
		const entry = await repo.findByIdOrSlug(collection, id);

		if (!entry) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		const revisionRepo = new RevisionRepository(db);

		const live = entry.liveRevisionId ? await revisionRepo.findById(entry.liveRevisionId) : null;
		const draft = entry.draftRevisionId ? await revisionRepo.findById(entry.draftRevisionId) : null;

		return {
			success: true,
			data: {
				hasChanges:
					entry.draftRevisionId !== null && entry.draftRevisionId !== entry.liveRevisionId,
				live: live?.data ?? null,
				draft: draft?.data ?? null,
			},
		};
	} catch (error) {
		console.error("Content compare error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_COMPARE_ERROR",
				message: "Failed to compare revisions",
			},
		};
	}
}

/**
 * Get all translations for a content item.
 * Returns the item's translation group members with locale and status info.
 */
export async function handleContentTranslations(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<
	ApiResult<{
		translationGroup: string;
		translations: Array<{
			id: string;
			locale: string | null;
			slug: string | null;
			status: string;
			updatedAt: string;
		}>;
	}>
> {
	try {
		const repo = new ContentRepository(db);
		const item = await repo.findByIdOrSlug(collection, id);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		if (!item.translationGroup) {
			return {
				success: true,
				data: {
					translationGroup: item.id,
					translations: [
						{
							id: item.id,
							locale: item.locale,
							slug: item.slug,
							status: item.status,
							updatedAt: item.updatedAt,
						},
					],
				},
			};
		}

		const translations = await repo.findTranslations(collection, item.translationGroup);

		return {
			success: true,
			data: {
				translationGroup: item.translationGroup,
				translations: translations.map((t) => ({
					id: t.id,
					locale: t.locale,
					slug: t.slug,
					status: t.status,
					updatedAt: t.updatedAt,
				})),
			},
		};
	} catch (error) {
		if (error instanceof Error) {
			console.error("Content translations error:", error);
		}
		return {
			success: false,
			error: {
				code: "CONTENT_TRANSLATIONS_ERROR",
				message: "Failed to get translations",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Non-translatable field sync
// ---------------------------------------------------------------------------

/**
 * Sync non-translatable fields to sibling locales.
 *
 * When a content item is updated and it belongs to a translation group,
 * any non-translatable fields in the update data are written to all other
 * rows in the same translation group within the same transaction.
 *
 * Non-translatable fields are **copied, not linked** — each row owns its
 * own data. This keeps queries simple and avoids cross-row joins.
 */
async function syncNonTranslatableFields(
	trx: Kysely<Database>,
	collectionSlug: string,
	updatedItemId: string,
	translationGroup: string,
	data: Record<string, unknown>,
): Promise<void> {
	// Get the collection to find its fields
	const collection = await trx
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();

	if (!collection) return;

	// Find non-translatable fields that are present in the update data
	const fields = await trx
		.selectFrom("_emdash_fields")
		.select("slug")
		.where("collection_id", "=", collection.id)
		.where("translatable", "=", 0)
		.execute();

	const nonTranslatableSlugs = fields.map((f) => f.slug);
	if (nonTranslatableSlugs.length === 0) return;

	// Filter to only the non-translatable fields present in this update
	const syncData: Record<string, unknown> = {};
	for (const slug of nonTranslatableSlugs) {
		if (slug in data) {
			syncData[slug] = data[slug];
		}
	}
	if (Object.keys(syncData).length === 0) return;

	// Build the SET clause for sibling rows
	validateIdentifier(collectionSlug, "collection slug");
	const tableName = `ec_${collectionSlug}`;

	// Update all sibling rows (same translation_group, different id)
	const setClauses = Object.entries(syncData).map(([key, value]) => {
		validateIdentifier(key, "field slug");
		const serialized = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
		return sql`${sql.ref(key)} = ${serialized}`;
	});

	await sql`
		UPDATE ${sql.ref(tableName)}
		SET ${sql.join(setClauses, sql`, `)}
		WHERE translation_group = ${translationGroup}
		AND id != ${updatedItemId}
	`.execute(trx);
}
