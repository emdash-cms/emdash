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

const contentFieldComparable = z.union([z.string().max(2048), z.number().finite()]);
const contentFieldFilterScalar = z.union([contentFieldComparable, z.boolean(), z.null()]);
const contentFieldFilterValue = z.union([
	contentFieldFilterScalar,
	z
		.object({
			in: z
				.array(z.union([contentFieldComparable, z.boolean()]))
				.min(1)
				.max(100),
		})
		.strict(),
	z
		.object({
			gt: contentFieldComparable.optional(),
			gte: contentFieldComparable.optional(),
			lt: contentFieldComparable.optional(),
			lte: contentFieldComparable.optional(),
		})
		.strict()
		.refine((value) => Object.values(value).some((bound) => bound !== undefined), {
			message: "Range filter must include at least one bound",
		}),
]);

/** AND-combined filters over custom fields explicitly marked as indexed. */
export const contentFieldFiltersSchema = z
	.record(
		z
			.string()
			.max(128)
			.regex(/^[a-z][a-z0-9_]*$/, "must be a safe field identifier"),
		contentFieldFilterValue,
	)
	.refine((filters) => Object.keys(filters).length <= 20, {
		message: "At most 20 indexed field filters are allowed",
	});

const contentFieldFiltersQuery = z
	.string()
	.max(8192)
	.transform((value, ctx): unknown => {
		try {
			return JSON.parse(value);
		} catch {
			ctx.addIssue({ code: "custom", message: "must be valid JSON" });
			return z.NEVER;
		}
	})
	.pipe(contentFieldFiltersSchema);

export const contentListQuery = cursorPaginationQuery
	.extend({
		status: z.string().optional(),
		orderBy: z.string().optional(),
		order: z.enum(["asc", "desc"]).optional(),
		locale: localeCode.optional(),
		/** Case-insensitive substring search across the collection's title/name/slug. */
		q: z.string().trim().min(1).max(200).optional(),
		/** Filter to entries authored by this user (the `author_id` column). */
		authorId: z.string().min(1).max(64).optional(),
		/** Which timestamp column the `dateFrom`/`dateTo` range applies to. */
		dateField: z.enum(["createdAt", "updatedAt", "publishedAt"]).optional(),
		/** Inclusive lower bound for the date range. Requires `dateField`. */
		dateFrom: contentDateBound,
		/** Inclusive upper bound for the date range. Requires `dateField`. */
		dateTo: contentDateBound,
		/** JSON-encoded indexed custom-field filters, combined with AND semantics. */
		fieldFilters: contentFieldFiltersQuery.optional(),
	})
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
