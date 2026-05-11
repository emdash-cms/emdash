import { z } from "zod";

// ---------------------------------------------------------------------------
// Taxonomy definitions: Input schemas
// ---------------------------------------------------------------------------

/** Collection slug format: lowercase alphanumeric + underscores, starts with letter */
const collectionSlugPattern = /^[a-z][a-z0-9_]*$/;

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
		collections: z
			.array(
				z.string().min(1).max(63).regex(collectionSlugPattern, "Invalid collection slug format"),
			)
			.max(100)
			.optional()
			.default([]),
		locale: z.string().min(1).optional(),
		translationOf: z.string().min(1).optional(),
	})
	.meta({ id: "CreateTaxonomyDefBody" });

// ---------------------------------------------------------------------------
// Taxonomy terms: Input schemas
// ---------------------------------------------------------------------------

export const createTermBody = z
	.object({
		slug: z.string().min(1),
		label: z.string().min(1),
		parentId: z.string().nullish(),
		description: z.string().optional(),
		locale: z.string().min(1).optional(),
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
		count: z.number().int(),
		children: z.array(z.lazy(() => termWithCountSchema)),
		locale: z.string(),
		translationGroup: z.string().nullable(),
	})
	.meta({ id: "TermWithCount" });

export const termListResponseSchema = z
	.object({ terms: z.array(termWithCountSchema) })
	.meta({ id: "TermListResponse" });

export const termResponseSchema = z.object({ term: termSchema }).meta({ id: "TermResponse" });

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
