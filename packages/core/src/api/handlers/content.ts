/**
 * Content CRUD handlers
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { BylineRepository } from "../../database/repositories/byline.js";
import type { ContentBylineInput } from "../../database/repositories/byline.js";
import { CommentRepository } from "../../database/repositories/comment.js";
import { ContentRepository } from "../../database/repositories/content.js";
import type { MediaUsageState } from "../../database/repositories/media-usage.js";
import { RedirectRepository } from "../../database/repositories/redirect.js";
import { RevisionRepository } from "../../database/repositories/revision.js";
import { SeoRepository } from "../../database/repositories/seo.js";
import {
	EmDashValidationError,
	ScheduledNotDueError,
	InvalidCursorError,
	type BylineSummary,
	type ContentBylineCredit,
	type ContentDateField,
	type ContentItem,
	type ContentSeo,
	type ContentSeoInput,
	type FindManyOptions,
} from "../../database/repositories/types.js";
import { UserRepository } from "../../database/repositories/user.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { getI18nConfig, isI18nEnabled } from "../../i18n/config.js";
import { deleteContentMediaUsage, replaceContentMediaUsage } from "../../media/usage-index.js";
import { invalidateRedirectCache } from "../../redirects/cache.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { encodeRev, validateRev } from "../rev.js";
import type { ApiResult, ContentListResponse, ContentResponse } from "../types.js";
import { validateMediaFields } from "./validate-media-fields.js";

const MEDIA_USAGE_FIELD_TYPES = new Set(["image", "file", "repeater", "portableText"]);

function getContentMediaUsageState(item: Pick<ContentItem, "status">): MediaUsageState {
	return item.status === "published" ? "live" : "draft";
}

async function replaceCurrentContentMediaUsage(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
	options: { contentDeletedAt?: string | null } = {},
): Promise<void> {
	const state = getContentMediaUsageState(item);
	let data = item.data;
	let revisionId: string | null = null;

	if (state === "draft" && item.draftRevisionId) {
		const revision = await new RevisionRepository(db).findById(item.draftRevisionId);
		if (revision) {
			data = revision.data;
			revisionId = revision.id;
		}
	}

	await replaceContentMediaUsage(
		db,
		collection,
		item,
		state,
		data,
		revisionId,
		options.contentDeletedAt ?? null,
	);
}

async function replaceCurrentContentMediaUsageSources(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
	options: { contentDeletedAt?: string | null } = {},
): Promise<void> {
	await replaceCurrentContentMediaUsage(db, collection, item, options);

	if (item.status !== "published" || !item.draftRevisionId) return;
	const draft = await new RevisionRepository(db).findById(item.draftRevisionId);
	if (!draft) return;

	await replaceContentMediaUsage(
		db,
		collection,
		item,
		"draft",
		draft.data,
		draft.id,
		options.contentDeletedAt ?? null,
	);
}

async function getContentDeletedAt(
	db: Kysely<Database>,
	collection: string,
	contentId: string,
): Promise<string | null> {
	validateIdentifier(collection, "collection slug");
	const tableName = `ec_${collection}`;
	const result = await sql<{ deleted_at: string | null }>`
		SELECT deleted_at FROM ${sql.ref(tableName)} WHERE id = ${contentId}
	`.execute(db);
	return result.rows[0]?.deleted_at ?? null;
}

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
	// Strict per-locale (migration 040): a credit at locale X renders iff a
	// byline row exists at locale X in the credited translation_group. The
	// junction itself spans translations; rendering does not fall back.
	const localeOpt = item.locale ? { locale: item.locale } : undefined;
	const bylines = await bylineRepo.getContentBylines(collection, item.id, localeOpt);

	if (bylines.length > 0) {
		item.bylines = bylines.map((c) => ({ ...c, source: "explicit" as const }));
		item.byline = bylines[0]?.byline ?? null;
		return;
	}

	// `primaryBylineId` is set iff junction rows exist; non-null
	// suppresses author fallback even when the credit doesn't resolve
	// at this locale.
	if (item.primaryBylineId) {
		item.bylines = [];
		item.byline = null;
		return;
	}

	if (item.authorId) {
		// Same strict-locale rule as explicit credits: a user-linked byline
		// renders on the entry only when a sibling exists at the entry's
		// locale. Without this we'd silently surface the default-locale
		// row, which contradicts the per-locale model.
		const fallback = await bylineRepo.findByUserId(item.authorId, localeOpt);
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
 *
 * Items may live at different locales (e.g. a list endpoint returning the
 * translations of an entry). Group by `item.locale` and call the strict
 * per-locale repo method once per group so each item resolves against its
 * own locale's byline rows.
 */
async function hydrateBylinesMany(
	db: Kysely<Database>,
	collection: string,
	items: ContentItem[],
): Promise<void> {
	if (items.length === 0) return;

	const bylineRepo = new BylineRepository(db);

	// 1. Bucket items by locale so we can call the strict-locale repo
	//    once per bucket. Items with a null/undefined locale (pre-i18n
	//    rows on a single-locale install) share an "unscoped" bucket.
	const localeBuckets = new Map<string | null, ContentItem[]>();
	for (const item of items) {
		const key = item.locale ?? null;
		const bucket = localeBuckets.get(key);
		if (bucket) bucket.push(item);
		else localeBuckets.set(key, [item]);
	}

	// 2. Per-locale: fetch explicit credits. Items whose credits don't
	//    resolve at this locale go through a locale-agnostic "has any
	//    junction" check before being considered for author inference —
	//    explicit editorial intent at any locale beats inferred fallback.
	const bylinesByItem = new Map<string, ContentBylineCredit[]>();
	const itemsNeedingAuthorCheck: ContentItem[] = [];
	for (const [locale, bucket] of localeBuckets) {
		const localeOpt = locale ? { locale } : undefined;
		const ids = bucket.map((i) => i.id);
		const credits = await bylineRepo.getContentBylinesMany(collection, ids, localeOpt);
		for (const [id, list] of credits) bylinesByItem.set(id, list);

		for (const item of bucket) {
			if (credits.has(item.id) && credits.get(item.id)!.length > 0) continue;
			if (item.authorId) itemsNeedingAuthorCheck.push(item);
		}
	}

	// 3. Author fallback applies only when no explicit credit exists
	//    (primaryBylineId null).
	const fallbackByItem = new Map<string, BylineSummary>();
	if (itemsNeedingAuthorCheck.length > 0) {
		const authorBuckets = new Map<string | null, ContentItem[]>();
		for (const item of itemsNeedingAuthorCheck) {
			if (item.primaryBylineId) continue;
			const key = item.locale ?? null;
			const bucket = authorBuckets.get(key);
			if (bucket) bucket.push(item);
			else authorBuckets.set(key, [item]);
		}

		for (const [locale, bucket] of authorBuckets) {
			const localeOpt = locale ? { locale } : undefined;
			const authorIds = bucket.map((i) => i.authorId).filter((id): id is string => id !== null);
			const uniqueAuthorIds = [...new Set(authorIds)];
			if (uniqueAuthorIds.length === 0) continue;
			const authorMap = await bylineRepo.findByUserIds(uniqueAuthorIds, localeOpt);
			for (const item of bucket) {
				if (!item.authorId) continue;
				const f = authorMap.get(item.authorId);
				if (f) fallbackByItem.set(item.id, f);
			}
		}
	}

	// 4. Assign to each item.
	for (const item of items) {
		const explicit = bylinesByItem.get(item.id);
		if (explicit && explicit.length > 0) {
			item.bylines = explicit.map((c) => ({ ...c, source: "explicit" as const }));
			item.byline = explicit[0]?.byline ?? null;
			continue;
		}

		const fallback = fallbackByItem.get(item.id);
		if (fallback) {
			item.bylines = [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }];
			item.byline = fallback;
			continue;
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
 * Resolve the columns a content-list search should match against. Always
 * includes `slug` (a standard column) and adds the `title`/`name` display
 * fields when the collection actually defines them, mirroring the admin's
 * item-title resolution (title -> name -> slug). Returning only existing
 * columns avoids "no such column" errors on collections without them.
 */
async function resolveSearchColumns(db: Kysely<Database>, collection: string): Promise<string[]> {
	const columns = ["slug"];
	const row = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collection)
		.executeTakeFirst();
	if (!row) return columns;

	const fields = await db
		.selectFrom("_emdash_fields")
		.select("slug")
		.where("collection_id", "=", row.id)
		.execute();
	const fieldSlugs = new Set(fields.map((f) => f.slug));
	for (const candidate of ["title", "name"]) {
		if (fieldSlugs.has(candidate)) columns.push(candidate);
	}
	return columns;
}

/** Matches a date-only `YYYY-MM-DD` bound (no time component). */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a date-range bound to an ISO datetime for lexicographic comparison
 * against stored ISO 8601 timestamps. A bare `YYYY-MM-DD` is widened to the
 * appropriate UTC day boundary so the range stays inclusive: a `start` bound
 * becomes the start of the day and an `end` bound the end of the day.
 * Otherwise a date-only upper bound would exclude every same-day row (since
 * `2024-06-01T12:00:00Z` sorts after `2024-06-01`). Full datetimes pass
 * through unchanged.
 */
function normalizeDateBound(value: string | undefined, edge: "start" | "end"): string | undefined {
	if (!value) return undefined;
	if (!DATE_ONLY_RE.test(value)) return value;
	return edge === "start" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
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
		q?: string;
		authorId?: string;
		dateField?: ContentDateField;
		dateFrom?: string;
		dateTo?: string;
	},
): Promise<ApiResult<ContentListResponse>> {
	try {
		const repo = new ContentRepository(db);
		const where: FindManyOptions["where"] = {};
		if (params.status) where.status = params.status;
		if (params.locale) where.locale = params.locale;
		if (params.authorId) where.authorId = params.authorId;

		// A date range requires a target column; ignore stray from/to without
		// a field so a half-specified filter doesn't silently drop all rows.
		if (params.dateField && (params.dateFrom || params.dateTo)) {
			where.dateFilter = {
				field: params.dateField,
				from: normalizeDateBound(params.dateFrom, "start"),
				to: normalizeDateBound(params.dateTo, "end"),
			};
		}

		const q = params.q?.trim();
		if (q) {
			where.q = q;
			where.searchColumns = await resolveSearchColumns(db, collection);
		}

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
				total: result.total,
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

/** A content author option for the admin author filter. */
export interface ContentAuthor {
	id: string;
	name: string | null;
	email: string;
	avatarUrl: string | null;
}

/**
 * List the distinct authors of a collection's live content.
 *
 * Backs the admin content-list author filter. Unlike `/admin/users` (ADMIN
 * only), this is gated on `content:read`, so any editor can filter by author.
 * Returns only users who have authored at least one non-trashed entry, sorted
 * by display name then email for a stable dropdown order.
 */
export async function handleContentAuthors(
	db: Kysely<Database>,
	collection: string,
): Promise<ApiResult<{ items: ContentAuthor[] }>> {
	try {
		const repo = new ContentRepository(db);
		const authorIds = await repo.findDistinctAuthorIds(collection);
		if (authorIds.length === 0) {
			return { success: true, data: { items: [] } };
		}

		const userRepo = new UserRepository(db);
		const users = await userRepo.findByIds(authorIds);

		const items: ContentAuthor[] = users
			.map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl }))
			.toSorted((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));

		return { success: true, data: { items } };
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
		console.error("Content authors error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_AUTHORS_ERROR",
				message: "Failed to list content authors",
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

		const mimeCheck = await validateMediaFields(db, collection, body.data);
		if (!mimeCheck.success) return mimeCheck;

		// Wrap content + SEO writes in a transaction for atomicity
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);

			// Default to the configured site locale rather than the repo's
			// hard-coded "en" — otherwise non-English default-locale sites
			// silently create entries in a locale the editor never chose.
			const effectiveLocale = body.locale ?? getI18nConfig()?.defaultLocale;

			let slug: string | null | undefined = body.slug;
			if (!slug) {
				const slugSource = getSlugSource(body.data);
				if (slugSource) {
					slug = await repo.generateUniqueSlug(collection, slugSource, effectiveLocale);
				}
			}

			const created = await repo.create({
				type: collection,
				slug,
				data: body.data,
				status: body.status || "draft",
				authorId: body.authorId,
				locale: effectiveLocale,
				translationOf: body.translationOf,
				createdAt: body.createdAt,
				publishedAt: body.publishedAt,
			});

			if (body.bylines !== undefined) {
				const credits = await bylineRepo.setContentBylines(collection, created.id, body.bylines);
				// `setContentBylines` translates wire row ids to their
				// `translation_group` before writing. The response-shape
				// `primaryBylineId` must match what's now in the DB, so read
				// it from the returned credit (whose `byline` came from a
				// hydration round-trip).
				created.primaryBylineId = credits[0]?.byline.translationGroup ?? null;
			}

			// When this row is a translation of an existing item, inherit
			// the source's taxonomy assignments AND byline credits. Both
			// pivots store translation_groups (taxonomies post-mig 036,
			// bylines post-mig 040), so a copied row applies across every
			// locale of the credited identity — and the locale-strict
			// hydration below renders the variant that matches the entry's
			// locale (or nothing if no variant exists yet at this locale,
			// which is the documented Phase 4 behaviour).
			//
			// Explicit `body.bylines` wins — `copyContentBylines` no-ops
			// when the target already has credits, but the cleaner guard
			// is to skip the call entirely.
			if (body.translationOf) {
				const { TaxonomyRepository } = await import("../../database/repositories/taxonomy.js");
				const taxRepo = new TaxonomyRepository(trx);
				await taxRepo.copyEntryTerms(collection, body.translationOf, created.id);

				if (body.bylines === undefined) {
					await bylineRepo.copyContentBylines(collection, body.translationOf, created.id);
					// `copyContentBylines` writes the source's primary
					// pointer onto the new row; reflect it in-memory so the
					// response includes it before hydrateBylines runs.
					const source = await repo.findById(collection, body.translationOf);
					if (source) created.primaryBylineId = source.primaryBylineId;
				}
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

			await replaceCurrentContentMediaUsage(trx, collection, created);

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
		locale?: string;
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

		if (body.data) {
			const mimeCheck = await validateMediaFields(db, collection, body.data);
			if (!mimeCheck.success) return mimeCheck;
		}

		const repo = new ContentRepository(db);

		// Resolve slug → ID if needed
		const resolvedId = (await resolveId(repo, collection, id, body.locale)) ?? id;

		// Wrap content + SEO writes in a transaction for atomicity.
		// The _rev check is inside the transaction so the read-then-write
		// is atomic -- no concurrent write can slip between the check and update.
		const item = await withTransaction(db, async (trx) => {
			const trxRepo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);

			// Read existing item once for both _rev check and old slug capture
			const existing =
				body._rev || body.slug !== undefined || body.status !== undefined
					? await trxRepo.findById(collection, resolvedId)
					: null;

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
				const credits = await bylineRepo.setContentBylines(collection, resolvedId, body.bylines);
				// `setContentBylines` translates wire row ids to their
				// `translation_group` before writing. Read the in-memory
				// pointer from the persisted credit so the response shape
				// matches the DB. See the matching block in handleContentCreate.
				updated.primaryBylineId = credits[0]?.byline.translationGroup ?? null;
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
			let syncedMediaUsageSiblingIds: string[] = [];
			if (isI18nEnabled() && body.data && updated.translationGroup) {
				syncedMediaUsageSiblingIds = await syncNonTranslatableFields(
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

			if (body.data !== undefined || body.status !== undefined || body.slug !== undefined) {
				const previousState = existing ? getContentMediaUsageState(existing) : null;
				const nextState = getContentMediaUsageState(updated);
				if (previousState && previousState !== nextState) {
					await deleteContentMediaUsage(trx, collection, resolvedId, previousState);
				}
				await replaceCurrentContentMediaUsageSources(trx, collection, updated);
			}
			for (const siblingId of syncedMediaUsageSiblingIds) {
				const sibling = await trxRepo.findById(collection, siblingId);
				if (sibling) await replaceCurrentContentMediaUsage(trx, collection, sibling);
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
			await replaceCurrentContentMediaUsage(trx, collection, dup);

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
			const didDelete = await repo.delete(collection, resolvedId);
			if (didDelete) {
				const item = await repo.findByIdIncludingTrashed(collection, resolvedId);
				const deletedAt = await getContentDeletedAt(trx, collection, resolvedId);
				if (item) {
					await replaceCurrentContentMediaUsageSources(trx, collection, item, {
						contentDeletedAt: deletedAt,
					});
				}
			}
			return didDelete;
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
): Promise<ApiResult<{ restored: true; item: ContentItem }>> {
	try {
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveIdIncludingTrashed(repo, collection, id)) ?? id;
			const restored = await repo.restore(collection, resolvedId);
			if (restored) await replaceCurrentContentMediaUsageSources(trx, collection, restored);
			return restored;
		});

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Trashed content item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { restored: true, item },
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
				await deleteContentMediaUsage(trx, collection, resolvedId);
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
			const scheduled = await repo.schedule(collection, resolvedId, scheduledAt);
			await replaceCurrentContentMediaUsage(trx, collection, scheduled);
			return scheduled;
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
			const unscheduled = await repo.unschedule(collection, resolvedId);
			await replaceCurrentContentMediaUsage(trx, collection, unscheduled);
			return unscheduled;
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
	options: { publishedAt?: string; requireScheduledDue?: boolean } = {},
): Promise<ApiResult<ContentResponse>> {
	try {
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			const published = await repo.publish(
				collection,
				resolvedId,
				options.publishedAt,
				options.requireScheduledDue,
			);
			await replaceContentMediaUsage(
				trx,
				collection,
				published,
				"live",
				published.data,
				published.liveRevisionId,
			);
			await deleteContentMediaUsage(trx, collection, resolvedId, "draft");
			return published;
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		// The scheduled sweep gates publish on the row still being due; a row
		// unscheduled in the meantime is a silent skip, not a failure.
		if (error instanceof ScheduledNotDueError) {
			return {
				success: false,
				error: {
					code: "NOT_DUE",
					message: error.message,
				},
			};
		}
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
			const unpublished = await repo.unpublish(collection, resolvedId);
			await deleteContentMediaUsage(trx, collection, resolvedId, "live");
			const draft = unpublished.draftRevisionId
				? await new RevisionRepository(trx).findById(unpublished.draftRevisionId)
				: null;
			await replaceContentMediaUsage(
				trx,
				collection,
				unpublished,
				"draft",
				draft?.data ?? unpublished.data,
				draft?.id ?? null,
			);
			return unpublished;
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
			const updated = await repo.discardDraft(collection, resolvedId);
			if (updated.status === "published") {
				await deleteContentMediaUsage(trx, collection, resolvedId, "draft");
			} else {
				await replaceCurrentContentMediaUsage(trx, collection, updated);
			}
			return updated;
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
): Promise<string[]> {
	// Get the collection to find its fields
	const collection = await trx
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();

	if (!collection) return [];

	// Find non-translatable fields that are present in the update data
	const fields = await trx
		.selectFrom("_emdash_fields")
		.select(["slug", "type"])
		.where("collection_id", "=", collection.id)
		.where("translatable", "=", 0)
		.execute();

	const nonTranslatableSlugs = fields.map((f) => f.slug);
	if (nonTranslatableSlugs.length === 0) return [];

	// Filter to only the non-translatable fields present in this update
	const syncData: Record<string, unknown> = {};
	for (const slug of nonTranslatableSlugs) {
		if (slug in data) {
			syncData[slug] = data[slug];
		}
	}
	if (Object.keys(syncData).length === 0) return [];
	const shouldReindexMediaUsage = fields.some(
		(field) => field.slug in syncData && MEDIA_USAGE_FIELD_TYPES.has(field.type),
	);

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

	if (!shouldReindexMediaUsage) return [];

	const siblings = await sql<{ id: string }>`
		SELECT id FROM ${sql.ref(tableName)}
		WHERE translation_group = ${translationGroup}
		AND id != ${updatedItemId}
	`.execute(trx);
	return siblings.rows.map((row) => row.id);
}
