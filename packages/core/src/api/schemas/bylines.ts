import { z } from "zod";

import { cursorPaginationQuery, httpUrl } from "./common.js";

/** Slug pattern: lowercase letters, digits, and hyphens; must start with a letter */
const bylineSlugPattern = /^[a-z][a-z0-9-]*$/;

export const bylineSummarySchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		displayName: z.string(),
		bio: z.string().nullable(),
		avatarMediaId: z.string().nullable(),
		websiteUrl: z.string().nullable(),
		userId: z.string().nullable(),
		isGuest: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string(),
		/** Locale this byline row is presented in (migration 040). */
		locale: z.string(),
		/**
		 * Shared across translations of the same byline (migration 040).
		 * Equals `id` for the anchor row; siblings inherit it from their
		 * source. Nullable in storage for backwards compatibility.
		 */
		translationGroup: z.string().nullable(),
	})
	.meta({ id: "BylineSummary" });

export const bylineCreditSchema = z
	.object({
		byline: bylineSummarySchema,
		sortOrder: z.number().int(),
		roleLabel: z.string().nullable(),
		source: z.enum(["explicit", "inferred"]).optional().meta({
			description: "Whether this credit was explicitly assigned or inferred from authorId",
		}),
	})
	.meta({ id: "BylineCredit" });

export const contentBylineInputSchema = z
	.object({
		bylineId: z.string().min(1),
		roleLabel: z.string().nullish(),
	})
	.meta({ id: "ContentBylineInput" });

export const bylinesListQuery = cursorPaginationQuery
	.extend({
		search: z.string().optional(),
		isGuest: z.coerce.boolean().optional(),
		userId: z.string().optional(),
		/**
		 * Filter by locale (strict per-locale matching, post-migration 040).
		 * Rejects empty strings so the picker can't silently fetch the
		 * unfiltered list when the admin URL has `?locale=` with no value.
		 */
		locale: z.string().min(1).optional(),
	})
	.meta({ id: "BylinesListQuery" });

export const bylineCreateBody = z
	.object({
		slug: z
			.string()
			.min(1)
			.regex(bylineSlugPattern, "Slug must contain only lowercase letters, digits, and hyphens"),
		displayName: z.string().min(1),
		bio: z.string().nullish(),
		avatarMediaId: z.string().nullish(),
		websiteUrl: httpUrl.nullish(),
		userId: z.string().nullish(),
		isGuest: z.boolean().optional(),
		/**
		 * Locale this byline row belongs to. When omitted, the DB DEFAULT (the
		 * configured `defaultLocale`) is used. Rejects empty strings — an
		 * empty locale would create rows no resolver requests.
		 */
		locale: z.string().min(1).optional(),
		/**
		 * When set, the new row joins the source byline's translation_group
		 * rather than minting a fresh one. Requires `locale`.
		 */
		translationOf: z.string().min(1).optional(),
	})
	.meta({ id: "BylineCreateBody" });

export const bylineTranslationCreateBody = z
	.object({
		locale: z.string().min(1),
		slug: z
			.string()
			.min(1)
			.regex(bylineSlugPattern, "Slug must contain only lowercase letters, digits, and hyphens")
			.optional(),
		displayName: z.string().min(1).optional(),
		bio: z.string().nullish(),
		avatarMediaId: z.string().nullish(),
		websiteUrl: httpUrl.nullish(),
	})
	.meta({ id: "BylineTranslationCreateBody" });

export const bylineTranslationsResponseSchema = z
	.object({
		items: z.array(bylineSummarySchema),
	})
	.meta({ id: "BylineTranslationsResponse" });

export const bylineUpdateBody = z
	.object({
		slug: z
			.string()
			.min(1)
			.regex(bylineSlugPattern, "Slug must contain only lowercase letters, digits, and hyphens")
			.optional(),
		displayName: z.string().min(1).optional(),
		bio: z.string().nullish(),
		avatarMediaId: z.string().nullish(),
		websiteUrl: httpUrl.nullish(),
		userId: z.string().nullish(),
		isGuest: z.boolean().optional(),
	})
	.meta({ id: "BylineUpdateBody" });

export const bylineListResponseSchema = z
	.object({
		items: z.array(bylineSummarySchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "BylineListResponse" });
