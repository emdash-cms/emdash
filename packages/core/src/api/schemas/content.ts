import { z } from "zod";

import { bylineSummarySchema, bylineCreditSchema, contentBylineInputSchema } from "./bylines.js";
import { cursorPaginationQuery, httpUrl, localeCode } from "./common.js";

// ---------------------------------------------------------------------------
// Content: Input schemas
// ---------------------------------------------------------------------------

/** SEO input — per-content meta fields */
export const contentSeoInput = z
	.object({
		title: z.string().max(200).nullish(),
		description: z.string().max(500).nullish(),
		image: z.string().nullish(),
		canonical: httpUrl.nullish(),
		noIndex: z.boolean().optional(),
	})
	.meta({ id: "ContentSeoInput" });

/** ISO 8601 date or datetime bound for the content-list date range filter. */
const contentDateBound = z
	.union([
		z.iso.datetime({ offset: true, message: "must be an ISO 8601 datetime" }),
		z.iso.date({ message: "must be an ISO 8601 date" }),
	])
	.optional();

/**
 * Byline ids for the content-list filter: either the literal `none` or a
 * comma-separated list, parsed into an array.
 *
 * The 25-id cap keeps the `IN (...)` clause clear of D1's bound-parameter
 * ceiling once the rest of the list query's placeholders are counted
 * (`SQL_BATCH_SIZE` is 50 for a query binding nothing else).
 */
const bylineFilterParam = z
	.string()
	.trim()
	.min(1)
	.max(2000)
	.optional()
	.transform((value) =>
		value === undefined
			? undefined
			: value === "none"
				? ("none" as const)
				: [...new Set(value.split(",").map((id) => id.trim()))].filter((id) => id.length > 0),
	)
	.refine((value) => value === undefined || value === "none" || value.length <= 25, {
		message: "at most 25 bylines may be selected",
	})
	.refine((value) => value === undefined || value === "none" || value.length > 0, {
		message: "must contain at least one byline id",
	});

/** Query-string boolean. Explicit values only — `z.coerce.boolean()` reads "false" as true. */
const booleanParam = z
	.enum(["1", "0", "true", "false"])
	.optional()
	.transform((value) => value === "1" || value === "true");

export const contentListQuery = cursorPaginationQuery
	.extend({
		status: z.string().optional(),
		orderBy: z.string().optional(),
		order: z.enum(["asc", "desc"]).optional(),
		locale: localeCode.optional(),
		/** Search across the collection's display fields, slug, and searchable custom fields. */
		q: z.string().trim().min(1).max(200).optional(),
		/** Filter to entries authored by this user (the `author_id` column). */
		authorId: z.string().min(1).max(64).optional(),
		/** Which timestamp column the `dateFrom`/`dateTo` range applies to. */
		dateField: z.enum(["createdAt", "updatedAt", "publishedAt"]).optional(),
		/** Inclusive lower bound for the date range. Requires `dateField`. */
		dateFrom: contentDateBound,
		/** Inclusive upper bound for the date range. Requires `dateField`. */
		dateTo: contentDateBound,
		/**
		 * Comma-separated byline ids; an entry matches if it is credited to any
		 * of them. The literal `none` (alone) matches entries with no byline.
		 */
		bylines: bylineFilterParam,
		/**
		 * Also match the byline inferred from an entry's author when it has no
		 * explicit credit — i.e. filter on the byline the list renders rather
		 * than on the credits stored against the entry. Off by default.
		 */
		includeInferredBylines: booleanParam,
	})
	.transform(({ bylines, ...rest }) => ({
		...rest,
		bylinesNone: bylines === "none",
		bylines: bylines === "none" ? undefined : bylines,
	}))
	.meta({ id: "ContentListQuery" });

/** ISO 8601 datetime for `publishedAt` / `createdAt`. Routes gate writes behind `content:publish_any`. */
const contentDateOverride = z.iso
	.datetime({ offset: true, message: "must be an ISO 8601 datetime" })
	.nullish();

export const contentCreateBody = z
	.object({
		data: z.record(z.string(), z.unknown()),
		slug: z.string().nullish(),
		status: z.enum(["draft"]).optional(),
		bylines: z.array(contentBylineInputSchema).optional(),
		locale: localeCode.optional(),
		translationOf: z.string().optional(),
		seo: contentSeoInput.optional(),
		taxonomies: z.record(z.string(), z.array(z.string())).optional().meta({
			description:
				"Taxonomy term assignments as { taxonomyName: [termSlug, ...] }, resolved in the entry's locale.",
		}),
		publishedAt: contentDateOverride,
		createdAt: contentDateOverride,
	})
	.meta({ id: "ContentCreateBody" });

export const contentUpdateBody = z
	.object({
		data: z.record(z.string(), z.unknown()).optional(),
		slug: z.string().nullish(),
		status: z.enum(["draft"]).optional(),
		authorId: z.string().nullish(),
		bylines: z.array(contentBylineInputSchema).optional(),
		_rev: z
			.string()
			.optional()
			.meta({ description: "Opaque revision token for optimistic concurrency" }),
		skipRevision: z.boolean().optional(),
		seo: contentSeoInput.optional(),
		taxonomies: z.record(z.string(), z.array(z.string())).optional().meta({
			description:
				"Replace taxonomy assignments as { taxonomyName: [termSlug, ...] }. Only named taxonomies are touched; pass an empty array to clear a taxonomy.",
		}),
		publishedAt: contentDateOverride,
	})
	.meta({ id: "ContentUpdateBody" });

export const contentScheduleBody = z
	.object({
		scheduledAt: z.string().min(1, "scheduledAt is required").meta({
			description: "ISO 8601 datetime for scheduled publishing",
			example: "2025-06-15T09:00:00Z",
		}),
	})
	.meta({ id: "ContentScheduleBody" });

export const contentPublishBody = z
	.object({
		// .optional() rather than .nullish(): publishing has no semantic
		// meaning for `null` (you can't "clear" a publish timestamp by
		// publishing). Tightening the schema here means callers either
		// pass a valid datetime or omit the field, and the route doesn't
		// have to silently drop a null that snuck through.
		publishedAt: z.iso
			.datetime({ offset: true, message: "must be an ISO 8601 datetime" })
			.optional()
			.meta({
				description:
					"Optional ISO 8601 datetime to backdate the publish (e.g. when migrating content). Requires content:publish_any permission. Without this, existing published_at is preserved on re-publish.",
			}),
	})
	.meta({ id: "ContentPublishBody" });

export const contentPreviewUrlBody = z
	.object({
		expiresIn: z.union([z.string(), z.number()]).optional(),
		pathPattern: z.string().optional(),
	})
	.meta({ id: "ContentPreviewUrlBody" });

export const contentTermsBody = z
	.object({
		termIds: z.array(z.string()),
	})
	.meta({ id: "ContentTermsBody" });

export const contentTrashQuery = cursorPaginationQuery;

// ---------------------------------------------------------------------------
// Content: Response schemas
// ---------------------------------------------------------------------------

/** SEO metadata on a content item */
export const contentSeoSchema = z
	.object({
		title: z.string().nullable(),
		description: z.string().nullable(),
		image: z.string().nullable(),
		canonical: z.string().nullable(),
		noIndex: z.boolean(),
	})
	.meta({ id: "ContentSeo" });

/** A single content item as returned by the API */
export const contentItemSchema = z
	.object({
		id: z.string(),
		type: z.string().meta({ description: "Collection slug this item belongs to" }),
		slug: z.string().nullable(),
		status: z.string().meta({ description: "draft, published, or scheduled" }),
		data: z.record(z.string(), z.unknown()).meta({
			description: "User-defined field values",
		}),
		authorId: z.string().nullable(),
		primaryBylineId: z.string().nullable(),
		byline: bylineSummarySchema.nullable().optional(),
		bylines: z.array(bylineCreditSchema).optional(),
		createdAt: z.string(),
		updatedAt: z.string(),
		publishedAt: z.string().nullable(),
		scheduledAt: z.string().nullable(),
		liveRevisionId: z.string().nullable(),
		draftRevisionId: z.string().nullable(),
		version: z.number().int(),
		locale: z.string().nullable(),
		translationGroup: z.string().nullable(),
		seo: contentSeoSchema.optional(),
	})
	.meta({ id: "ContentItem" });

/** Response for single content item endpoints (get, create, update) */
export const contentResponseSchema = z
	.object({
		item: contentItemSchema,
		_rev: z
			.string()
			.optional()
			.meta({ description: "Opaque revision token for optimistic concurrency" }),
	})
	.meta({ id: "ContentResponse" });

/** Response for content list endpoints */
export const contentListResponseSchema = z
	.object({
		items: z.array(contentItemSchema),
		nextCursor: z.string().optional(),
		total: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "ContentListResponse" });

/** A distinct content author for the admin author filter */
export const contentAuthorSchema = z
	.object({
		id: z.string(),
		name: z.string().nullable(),
		email: z.string(),
		avatarUrl: z.string().nullable(),
	})
	.meta({ id: "ContentAuthor" });

/** Response for the content authors endpoint */
export const contentAuthorsResponseSchema = z
	.object({
		items: z.array(contentAuthorSchema),
	})
	.meta({ id: "ContentAuthorsResponse" });

/** Trashed content item */
export const trashedContentItemSchema = z
	.object({
		id: z.string(),
		type: z.string(),
		slug: z.string().nullable(),
		status: z.string(),
		data: z.record(z.string(), z.unknown()),
		authorId: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
		publishedAt: z.string().nullable(),
		deletedAt: z.string(),
	})
	.meta({ id: "TrashedContentItem" });

/** Response for trashed content list */
export const trashedContentListResponseSchema = z
	.object({
		items: z.array(trashedContentItemSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "TrashedContentListResponse" });

/** Response for content compare (live vs draft) */
export const contentCompareResponseSchema = z
	.object({
		hasChanges: z.boolean(),
		live: z.record(z.string(), z.unknown()).nullable(),
		draft: z.record(z.string(), z.unknown()).nullable(),
	})
	.meta({ id: "ContentCompareResponse" });

/** Translation summary for a content item */
export const contentTranslationSchema = z.object({
	id: z.string(),
	locale: z.string().nullable(),
	slug: z.string().nullable(),
	status: z.string(),
	updatedAt: z.string(),
});

/** Response for content translations endpoint */
export const contentTranslationsResponseSchema = z
	.object({
		translationGroup: z.string(),
		translations: z.array(contentTranslationSchema),
	})
	.meta({ id: "ContentTranslationsResponse" });
