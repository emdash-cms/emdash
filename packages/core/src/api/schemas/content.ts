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

export const contentListQuery = cursorPaginationQuery
	.extend({
		status: z.string().optional(),
		orderBy: z.string().optional(),
		order: z.enum(["asc", "desc"]).optional(),
		locale: localeCode.optional(),
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
		publishedAt: contentDateOverride.meta({
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
	})
	.meta({ id: "ContentListResponse" });

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
