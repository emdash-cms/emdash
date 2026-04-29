import { z } from "zod";

import { slugPattern } from "./common.js";

// ---------------------------------------------------------------------------
// Schema (collections & fields): Input schemas
// ---------------------------------------------------------------------------

const collectionSupportValues = z.enum(["drafts", "revisions", "preview", "scheduling", "search"]);

const collectionSourcePattern = /^(template:.+|import:.+|manual|discovered|seed)$/;

const fieldTypeValues = z.enum([
	"string",
	"text",
	"url",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
	"portableText",
	"image",
	"file",
	"reference",
	"json",
	"slug",
	"repeater",
]);

const repeaterSubFieldSchema = z.object({
	slug: z.string().min(1).max(63).regex(slugPattern, "Invalid slug format"),
	type: z.enum(["string", "text", "number", "integer", "boolean", "datetime", "select"]),
	label: z.string().min(1),
	required: z.boolean().optional(),
	options: z.array(z.string()).optional(),
});

const fieldValidation = z
	.object({
		required: z.boolean().optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		minLength: z.number().int().min(0).optional(),
		maxLength: z.number().int().min(0).optional(),
		pattern: z.string().optional(),
		options: z.array(z.string()).optional(),
		subFields: z.array(repeaterSubFieldSchema).min(1).optional(),
		minItems: z.number().int().min(0).optional(),
		maxItems: z.number().int().min(1).optional(),
	})
	.optional();

const fieldWidgetOptions = z.record(z.string(), z.unknown()).optional();

export const createCollectionBody = z
	.object({
		slug: z.string().min(1).max(63).regex(slugPattern, "Invalid slug format"),
		label: z.string().min(1),
		labelSingular: z.string().optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
		supports: z.array(collectionSupportValues).optional(),
		source: z.string().regex(collectionSourcePattern).optional(),
		urlPattern: z.string().optional(),
		hasSeo: z.boolean().optional(),
	})
	.meta({ id: "CreateCollectionBody" });

export const updateCollectionBody = z
	.object({
		label: z.string().min(1).optional(),
		labelSingular: z.string().optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
		supports: z.array(collectionSupportValues).optional(),
		urlPattern: z.string().nullish(),
		hasSeo: z.boolean().optional(),
		commentsEnabled: z.boolean().optional(),
		commentsModeration: z.enum(["all", "first_time", "none"]).optional(),
		commentsClosedAfterDays: z.number().int().min(0).optional(),
		commentsAutoApproveUsers: z.boolean().optional(),
	})
	.meta({ id: "UpdateCollectionBody" });

export const createFieldBody = z
	.object({
		slug: z.string().min(1).max(63).regex(slugPattern, "Invalid slug format"),
		label: z.string().min(1),
		type: fieldTypeValues,
		required: z.boolean().optional(),
		unique: z.boolean().optional(),
		defaultValue: z.unknown().optional(),
		validation: fieldValidation,
		widget: z.string().optional(),
		options: fieldWidgetOptions,
		sortOrder: z.number().int().min(0).optional(),
		searchable: z.boolean().optional(),
		translatable: z.boolean().optional(),
	})
	.meta({ id: "CreateFieldBody" });

export const updateFieldBody = z
	.object({
		label: z.string().min(1).optional(),
		required: z.boolean().optional(),
		unique: z.boolean().optional(),
		defaultValue: z.unknown().optional(),
		validation: fieldValidation,
		widget: z.string().optional(),
		options: fieldWidgetOptions,
		sortOrder: z.number().int().min(0).optional(),
		searchable: z.boolean().optional(),
		translatable: z.boolean().optional(),
	})
	.meta({ id: "UpdateFieldBody" });

export const fieldReorderBody = z
	.object({
		fieldSlugs: z.array(z.string().min(1)),
	})
	.meta({ id: "FieldReorderBody" });

export const orphanRegisterBody = z
	.object({
		label: z.string().optional(),
		labelSingular: z.string().optional(),
		description: z.string().optional(),
	})
	.meta({ id: "OrphanRegisterBody" });

export const schemaExportQuery = z.object({
	format: z.string().optional(),
});

export const collectionGetQuery = z.object({
	includeFields: z
		.string()
		.transform((v) => v === "true")
		.optional(),
});

// ---------------------------------------------------------------------------
// Schema: Response schemas
// ---------------------------------------------------------------------------

export const collectionSchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		label: z.string(),
		labelSingular: z.string().nullable(),
		description: z.string().nullable(),
		icon: z.string().nullable(),
		supports: z.array(z.string()),
		source: z.string().nullable(),
		urlPattern: z.string().nullable(),
		hasSeo: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "Collection" });

export const fieldSchema = z
	.object({
		id: z.string(),
		collectionId: z.string(),
		slug: z.string(),
		label: z.string(),
		type: fieldTypeValues,
		required: z.boolean(),
		unique: z.boolean(),
		defaultValue: z.unknown().nullable(),
		validation: z.record(z.string(), z.unknown()).nullable(),
		widget: z.string().nullable(),
		options: z.record(z.string(), z.unknown()).nullable(),
		sortOrder: z.number().int(),
		searchable: z.boolean(),
		translatable: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "Field" });

export const collectionResponseSchema = z
	.object({ item: collectionSchema })
	.meta({ id: "CollectionResponse" });

export const collectionWithFieldsResponseSchema = z
	.object({
		item: collectionSchema.extend({ fields: z.array(fieldSchema) }),
	})
	.meta({ id: "CollectionWithFieldsResponse" });

export const collectionListResponseSchema = z
	.object({ items: z.array(collectionSchema) })
	.meta({ id: "CollectionListResponse" });

export const fieldResponseSchema = z.object({ item: fieldSchema }).meta({ id: "FieldResponse" });

export const fieldListResponseSchema = z
	.object({ items: z.array(fieldSchema) })
	.meta({ id: "FieldListResponse" });

export const orphanedTableSchema = z
	.object({
		slug: z.string(),
		tableName: z.string(),
		rowCount: z.number().int(),
	})
	.meta({ id: "OrphanedTable" });

export const orphanedTableListResponseSchema = z
	.object({ items: z.array(orphanedTableSchema) })
	.meta({ id: "OrphanedTableListResponse" });
