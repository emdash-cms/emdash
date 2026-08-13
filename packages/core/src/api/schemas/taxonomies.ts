import { z } from "zod";

import { localeCode } from "./common.js";

// ---------------------------------------------------------------------------
// Taxonomy definitions: Input schemas
// ---------------------------------------------------------------------------

/** Collection slug format: lowercase alphanumeric + underscores, starts with letter */
const collectionSlugPattern = /^[a-z][a-z0-9_]*$/;

const collectionSlug = z
	.string()
	.min(1)
	.max(63)
	.regex(collectionSlugPattern, "Invalid collection slug format");

export const createTaxonomyDefBody = z
	.object({
		name: z
			.string()
			.min(1)
			.max(63)
			.regex(/^[a-z][a-z0-9_]*$/, "Name must be lowercase alphanumeric with underscores"),
		label: z.string().min(1).max(200),
		labelSingular: z.string().min(1).max(200).optional(),
		hierarchical: z.boolean().optional().default(false),
		collections: z.array(collectionSlug).max(100).optional().default([]),
		locale: localeCode.optional(),
		translationOf: z.string().min(1).optional(),
	})
	.meta({ id: "CreateTaxonomyDefBody" });

/**
 * `name` and `locale` are absent on purpose: both identify the definition row
 * being written, and `.strict()` turns an attempt to change either into a 400
 * rather than a silently ignored field.
 */
export const updateTaxonomyDefBody = z
	.object({
		label: z.string().min(1).max(200).optional(),
		labelSingular: z.string().min(1).max(200).nullish(),
		hierarchical: z.boolean().optional(),
		collections: z.array(collectionSlug).max(100).optional(),
	})
	.strict()
	.meta({ id: "UpdateTaxonomyDefBody" });

// ---------------------------------------------------------------------------
// Taxonomy terms: Input schemas
// ---------------------------------------------------------------------------

export const createTermBody = z
	.object({
		slug: z.string().min(1),
		label: z.string().min(1),
		parentId: z.string().nullish(),
		description: z.string().optional(),
		locale: localeCode.optional(),
		translationOf: z.string().min(1).optional(),
	})
	.meta({ id: "CreateTermBody" });

export const updateTermBody = z
	.object({
		slug: z.string().min(1).optional(),
		label: z.string().min(1).optional(),
		parentId: z.string().nullish(),
		description: z.string().optional(),
	})
	.meta({ id: "UpdateTermBody" });

export const reorderTermsBody = z
	.object({
		parentId: z.string().min(1).nullish().meta({
			description:
				"Parent term whose children are being ordered (translation_group or row id). Omit or null for the top level, which for a flat taxonomy is every term.",
		}),
		ids: z.array(z.string().min(1)).max(100).meta({
			description:
				"Terms to move, in the desired order — each a row id or translation_group. May be a subset of the group: the listed terms are permuted within the positions they already occupy and every other member keeps its place. An id outside the group is rejected with REORDER_MISMATCH.",
		}),
	})
	.strict()
	.meta({ id: "ReorderTermsBody" });

export const termListQuery = z
	.object({
		locale: localeCode.optional(),
		includeCounts: z
			.enum(["true", "false"])
			.transform((v) => v === "true")
			.optional()
			.default(true)
			.meta({
				description:
					"Include each term's visible-usage count. Pass false to skip the aggregate; `count` is then absent from every term.",
			}),
	})
	.meta({ id: "TermListQuery" });

// ---------------------------------------------------------------------------
// Taxonomies: Response schemas
// ---------------------------------------------------------------------------

export const taxonomyDefSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		label: z.string(),
		labelSingular: z.string().optional(),
		hierarchical: z.boolean(),
		collections: z.array(z.string()),
		locale: z.string(),
		translationGroup: z.string().nullable(),
	})
	.meta({ id: "TaxonomyDef" });

export const taxonomyDefTranslationsSchema = z
	.object({
		translationGroup: z.string().nullable(),
		translations: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				label: z.string(),
				locale: z.string(),
			}),
		),
	})
	.meta({ id: "TaxonomyDefTranslations" });

export const taxonomyListResponseSchema = z
	.object({ taxonomies: z.array(taxonomyDefSchema) })
	.meta({ id: "TaxonomyListResponse" });

export const taxonomyResponseSchema = z
	.object({ taxonomy: taxonomyDefSchema })
	.meta({ id: "TaxonomyResponse" });

export const termSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		slug: z.string(),
		label: z.string(),
		parentId: z.string().nullable(),
		description: z.string().optional(),
		locale: z.string(),
		translationGroup: z.string().nullable(),
	})
	.meta({ id: "Term" });

export const termTranslationsSchema = z
	.object({
		translationGroup: z.string().nullable(),
		translations: z.array(
			z.object({
				id: z.string(),
				slug: z.string(),
				label: z.string(),
				locale: z.string(),
			}),
		),
	})
	.meta({ id: "TermTranslations" });

export const termWithCountSchema: z.ZodType = z
	.object({
		id: z.string(),
		name: z.string(),
		slug: z.string(),
		label: z.string(),
		parentId: z.string().nullable(),
		description: z.string().optional(),
		count: z.number().int().optional(),
		children: z.array(z.lazy(() => termWithCountSchema)),
		locale: z.string(),
		translationGroup: z.string().nullable(),
	})
	.meta({ id: "TermWithCount" });

export const termListResponseSchema = z
	.object({ terms: z.array(termWithCountSchema) })
	.meta({ id: "TermListResponse" });

export const termResponseSchema = z.object({ term: termSchema }).meta({ id: "TermResponse" });

export const termReorderResponseSchema = z
	.object({ reordered: z.literal(true) })
	.meta({ id: "TermReorderResponse" });

export const termGetResponseSchema = z
	.object({
		term: termSchema.extend({
			count: z.number().int(),
			children: z.array(
				z.object({
					id: z.string(),
					slug: z.string(),
					label: z.string(),
				}),
			),
		}),
	})
	.meta({ id: "TermGetResponse" });
