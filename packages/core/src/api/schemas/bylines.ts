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
		/**
		 * Avatar media storage key + alt, folded in by the media join during
		 * content byline hydration. Null on the plain byline finders, which
		 * don't join media.
		 */
		avatarStorageKey: z.string().nullish(),
		avatarAlt: z.string().nullish(),
		/**
		 * Avatar media LQIP placeholder (blurhash + dominant colour, migration
		 * 024), from the same media join. Lets clients render a placeholder
		 * while the avatar loads. Null under the same conditions as
		 * `avatarStorageKey`.
		 */
		avatarBlurhash: z.string().nullish(),
		avatarDominantColor: z.string().nullish(),
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
		/**
		 * Byline custom-field values (Discussion #1174). Keys are slugs
		 * registered via the byline-fields admin API; values follow
		 * `CustomFieldValue` (`string | boolean | null`). Always present
		 * on hydrated responses — empty `{}` when no fields are
		 * registered (Phase 3 AC #6). Marked optional in the schema for
		 * historic-payload compatibility with pre-Phase-3 clients that
		 * may not send the key on writes; hydration always populates it.
		 */
		customFields: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])).optional(),
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
		/**
		 * Byline custom-field values (Discussion #1174, Phase 6 — create-flow
		 * parity with update). Keys are field slugs; values are unknown at
		 * the API layer because the per-field type contract lives in the
		 * registry and would require an extra query to enforce here. The
		 * repository's `coerceFieldValue` validates against the field's
		 * type and throws `EmDashValidationError` on mismatch — the route
		 * maps that to a 400 `VALIDATION_ERROR`. Reserved-slug write
		 * attempts fall out as `EmDashValidationError("Unknown byline
		 * custom field …")` because no registered field claims a reserved
		 * slug.
		 */
		customFields: z.record(z.string(), z.unknown()).optional(),
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
		/**
		 * Byline custom-field values (Discussion #1174, Phase 3+4). Keys
		 * are field slugs; values are unknown at the API layer because
		 * the per-field type contract lives in the registry and would
		 * require an extra query to enforce here. The repository's
		 * `coerceFieldValue` validates against the field's type and
		 * throws `EmDashValidationError` on mismatch — the route maps
		 * that to a 400 `VALIDATION_ERROR`. Reserved-slug write attempts
		 * fall out as `EmDashValidationError("Unknown byline custom
		 * field …")` because no registered field claims a reserved slug.
		 */
		customFields: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "BylineUpdateBody" });

export const bylineListResponseSchema = z
	.object({
		items: z.array(bylineSummarySchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "BylineListResponse" });
