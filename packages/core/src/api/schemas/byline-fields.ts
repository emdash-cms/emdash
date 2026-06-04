/**
 * Zod schemas for the byline-fields admin API (Discussion #1174, Phase 4).
 *
 * Reserved-slug + identifier validation runs at the zod layer so the
 * route returns a clean 400 (`VALIDATION_ERROR` from `parseBody`) rather
 * than bubbling a registry-level `BylineSchemaError` ("RESERVED_SLUG" /
 * "INVALID_SLUG"). The registry repeats the same checks for non-HTTP
 * callers (seeds, scripts) — see `BylineSchemaRegistry.validateSlug`.
 *
 * Field types are constrained to the v1 subset declared in
 * `BYLINE_FIELD_TYPES`. Adding a type to the union there will require a
 * corresponding update to this enum.
 */

import { z } from "zod";

import { BYLINE_FIELD_TYPES, RESERVED_BYLINE_FIELD_SLUGS } from "../../schema/types.js";

/**
 * Slug pattern for byline field definitions — matches the identifier rule
 * used by `validateIdentifier` (and `slugPattern` in `common.ts`).
 * Lowercase letters, digits, and underscores; must start with a letter.
 */
const bylineFieldSlugPattern = /^[a-z][a-z0-9_]*$/;

/** Hard cap on a slug — mirrors `BylineSchemaRegistry.MAX_SLUG_LENGTH`. */
const MAX_SLUG_LENGTH = 63;
/** Hard cap on a label — mirrors `BylineSchemaRegistry.MAX_LABEL_LENGTH`. */
const MAX_LABEL_LENGTH = 200;
/** Hard cap on a select field's `options` list. */
const MAX_SELECT_OPTIONS = 200;

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_BYLINE_FIELD_SLUGS);

// Enumerate the v1 byline field types explicitly so zod gets the exact
// literal union for `z.infer<>`. Mirrors `BYLINE_FIELD_TYPES`; CI's
// type-checker catches drift via the satisfies/import below.
const bylineFieldTypeValues = z.enum(["string", "text", "url", "boolean", "select"]);
// Compile-time guard: a drift here trips the satisfies check.
type _BylineFieldTypeDriftCheck =
	(typeof BYLINE_FIELD_TYPES)[number] extends z.infer<typeof bylineFieldTypeValues>
		? z.infer<typeof bylineFieldTypeValues> extends (typeof BYLINE_FIELD_TYPES)[number]
			? true
			: never
		: never;
const _bylineFieldTypeDriftCheck: _BylineFieldTypeDriftCheck = true;
void _bylineFieldTypeDriftCheck;

/**
 * Validation payload for a byline custom field. v1 only exposes
 * `options` (used by `select`-type fields). Empty/duplicate options are
 * rejected at the registry layer; the zod layer only enforces shape and
 * caps. Future field types may add keys here.
 */
const bylineFieldValidationSchema = z
	.object({
		options: z
			.array(z.string().min(1))
			.min(1, "select options must contain at least one entry")
			.max(MAX_SELECT_OPTIONS, `select options cannot exceed ${MAX_SELECT_OPTIONS} entries`)
			.optional(),
	})
	.strict()
	.nullable();

/**
 * Slug validation chain shared by create + reorder bodies. Centralised so
 * the reserved-slug message and pattern are identical everywhere.
 */
const bylineFieldSlug = z
	.string()
	.min(1, "Byline field slug is required")
	.max(MAX_SLUG_LENGTH, `Byline field slug must be ${MAX_SLUG_LENGTH} characters or less`)
	.regex(
		bylineFieldSlugPattern,
		"Byline field slug must contain only lowercase letters, digits, and underscores, and start with a letter",
	)
	.refine((slug) => !RESERVED_SET.has(slug), {
		// Surface the offending slug in the validation issue path-message
		// for easier debugging from the admin UI's error toast.
		message: "Byline field slug is reserved",
	});

const bylineFieldLabel = z
	.string()
	.min(1, "Byline field label is required")
	.max(MAX_LABEL_LENGTH, `Byline field label must be ${MAX_LABEL_LENGTH} characters or less`);

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const bylineFieldCreateBody = z
	.object({
		slug: bylineFieldSlug,
		label: bylineFieldLabel,
		type: bylineFieldTypeValues,
		required: z.boolean().optional(),
		/**
		 * Whether values are stored per-locale (translatable, default) or
		 * shared across the translation group. See `BylineFieldDefinition`.
		 */
		translatable: z.boolean().optional(),
		validation: bylineFieldValidationSchema.optional(),
		sortOrder: z.number().int().min(0).optional(),
	})
	.strict()
	.meta({ id: "BylineFieldCreateBody" });

/**
 * Update body. `slug` and `type` are intentionally absent — both are
 * immutable post-create (changing them would invalidate stored values).
 * `translatable` flips are gated at the registry layer when value rows
 * exist (`TRANSLATABLE_LOCKED`).
 */
export const bylineFieldUpdateBody = z
	.object({
		label: bylineFieldLabel.optional(),
		required: z.boolean().optional(),
		translatable: z.boolean().optional(),
		validation: bylineFieldValidationSchema.optional(),
		sortOrder: z.number().int().min(0).optional(),
	})
	.strict()
	.meta({ id: "BylineFieldUpdateBody" });

export const bylineFieldReorderBody = z
	.object({
		/**
		 * Exact set of currently registered slugs in the desired order.
		 * The registry rejects any drift (`REORDER_MISMATCH`); the zod
		 * layer enforces slug shape only. An empty array is permitted —
		 * `reorderFields([])` is a valid no-op when zero fields are
		 * registered (registry contract). Rejecting empty here would
		 * produce a spurious 400 for an admin UI that submits a reorder
		 * after deleting the last field.
		 */
		slugs: z.array(bylineFieldSlug),
	})
	.strict()
	.meta({ id: "BylineFieldReorderBody" });

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const bylineFieldDefinitionSchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		label: z.string(),
		type: bylineFieldTypeValues,
		required: z.boolean(),
		translatable: z.boolean(),
		validation: z
			.object({
				options: z.array(z.string()).optional(),
			})
			.nullable(),
		sortOrder: z.number().int(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "BylineFieldDefinition" });

export const bylineFieldListResponseSchema = z
	.object({
		items: z.array(bylineFieldDefinitionSchema),
	})
	.meta({ id: "BylineFieldListResponse" });

/**
 * Response shape for `GET /api/admin/byline-fields/[slug]/usage`.
 *
 * `translatableValueCount` counts rows in `_emdash_byline_field_values`.
 * `groupValueCount` counts rows in `_emdash_byline_field_group_values`.
 * `totalAffectedRows` is the sum — what the destructive-delete confirm
 * dialog surfaces. Both individual counts are exposed for diagnostic
 * value (e.g. inconsistency with the field's current `translatable`
 * flag would show non-zero on the "wrong" side).
 */
export const bylineFieldUsageResponseSchema = z
	.object({
		translatableValueCount: z.number().int().nonnegative(),
		groupValueCount: z.number().int().nonnegative(),
		totalAffectedRows: z.number().int().nonnegative(),
	})
	.meta({ id: "BylineFieldUsageResponse" });
