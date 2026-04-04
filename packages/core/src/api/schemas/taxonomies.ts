import { z } from "zod";

// ---------------------------------------------------------------------------
// Taxonomy definitions: Input schemas
// ---------------------------------------------------------------------------

/** Collection slug format: lowercase alphanumeric + underscores, starts with letter */
const collectionSlugPattern = /^[a-z][a-z0-9_]*$/;

/** Schema for a custom field definition on a taxonomy type */
export const taxonomyFieldDef = z.object({
	name: z.string().min(1),
	label: z.string().min(1),
	type: z.enum(["string", "text", "number", "integer", "boolean", "datetime", "select", "multiSelect", "image", "file", "reference", "json", "url", "color"]),
	required: z.boolean().optional(),
	options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
	widget: z.string().optional(),
	validation: z.object({
		min: z.number().optional(),
		max: z.number().optional(),
		minLength: z.number().optional(),
		maxLength: z.number().optional(),
		pattern: z.string().optional(),
	}).optional(),
	defaultValue: z.unknown().optional(),
}).meta({ id: "TaxonomyFieldDef" });

export const createTaxonomyDefBody = z
	.object({
		name: z
			.string()
			.min(1)
			.max(63)
			.regex(/^[a-z][a-z0-9_]*$/, "Name must be lowercase alphanumeric with underscores"),
		label: z.string().min(1).max(200),
		hierarchical: z.boolean().optional().default(false),
		collections: z
			.array(
				z.string().min(1).max(63).regex(collectionSlugPattern, "Invalid collection slug format"),
			)
			.max(100)
			.optional()
			.default([]),
		fields: z.array(taxonomyFieldDef).optional(),
		supports: z.array(z.string()).optional(),
		hasSeo: z.boolean().optional(),
	})
	.meta({ id: "CreateTaxonomyDefBody" });

export const updateTaxonomyDefBody = z
	.object({
		label: z.string().min(1).max(200).optional(),
		hierarchical: z.boolean().optional(),
		collections: z
			.array(
				z.string().min(1).max(63).regex(collectionSlugPattern, "Invalid collection slug format"),
			)
			.max(100)
			.optional(),
		fields: z.array(taxonomyFieldDef).optional(),
		supports: z.array(z.string()).optional(),
		hasSeo: z.boolean().optional(),
	})
	.meta({ id: "UpdateTaxonomyDefBody" });

// ---------------------------------------------------------------------------
// Taxonomy terms: Input schemas
// ---------------------------------------------------------------------------

/** SEO input for taxonomy terms */
export const termSeoInput = z.object({
	title: z.string().nullish(),
	description: z.string().nullish(),
	image: z.string().nullish(),
	canonical: z.string().url().nullish(),
	noIndex: z.boolean().optional(),
});

export const createTermBody = z
	.object({
		slug: z.string().min(1),
		label: z.string().min(1),
		parentId: z.string().nullish(),
		description: z.string().optional(),
		data: z.record(z.unknown()).optional(),
	})
	.meta({ id: "CreateTermBody" });

export const updateTermBody = z
	.object({
		slug: z.string().min(1).optional(),
		label: z.string().min(1).optional(),
		parentId: z.string().nullish(),
		description: z.string().optional(),
		data: z.record(z.unknown()).optional(),
		seo: termSeoInput.optional(),
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
		fields: z.array(taxonomyFieldDef).optional(),
		supports: z.array(z.string()).optional(),
		hasSeo: z.boolean().optional(),
	})
	.meta({ id: "TaxonomyDef" });

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
		data: z.record(z.unknown()).optional(),
		seo: z.object({
			title: z.string().nullable(),
			description: z.string().nullable(),
			image: z.string().nullable(),
			canonical: z.string().nullable(),
			noIndex: z.boolean(),
		}).optional(),
	})
	.meta({ id: "Term" });

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
