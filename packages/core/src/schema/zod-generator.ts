import { z, type ZodTypeAny } from "zod";

import { hashString } from "../utils/hash.js";
import type { Field, FieldType, CollectionWithFields } from "./types.js";

/** Pattern to split on underscores, hyphens, and spaces for PascalCase conversion */
const PASCAL_CASE_SPLIT_PATTERN = /[_\-\s]+/;

/**
 * Generate a Zod schema from a collection's field definitions
 *
 * This allows runtime validation of content based on dynamically
 * defined schemas stored in D1.
 */
export function generateZodSchema(
	collection: CollectionWithFields,
): z.ZodObject<Record<string, ZodTypeAny>> {
	const shape: Record<string, ZodTypeAny> = {};

	for (const field of collection.fields) {
		shape[field.slug] = generateFieldSchema(field);
	}

	return z.object(shape);
}

/**
 * Generate Zod schema for a single field
 */
export function generateFieldSchema(field: Field): ZodTypeAny {
	let schema = getBaseSchema(field.type, field);

	// Apply validation rules
	if (field.validation) {
		schema = applyValidation(schema, field);
	}

	// Apply required/optional. Non-required fields use `.nullish()` rather
	// than `.optional()` because the underlying SQLite columns are nullable
	// (see `SchemaRegistry.addFieldColumn` -- non-required fields are added
	// without `NOT NULL`). The admin re-sends what it loaded from the
	// server on autosave, so any field that's actually `null` in the DB
	// must round-trip cleanly through the validator. `.optional()` only
	// accepts `undefined`; `.nullish()` accepts both `undefined` and
	// `null`. (#867 — autosave failures on seeded entries.)
	if (!field.required) {
		schema = schema.nullish();
	}

	// Apply default value
	if (field.defaultValue !== undefined) {
		schema = schema.default(field.defaultValue);
	}

	return schema;
}

/**
 * Get base Zod schema for a field type
 */
function getBaseSchema(type: FieldType, field: Field): ZodTypeAny {
	switch (type) {
		case "url":
			return z.string().url();

		case "string":
		case "text":
		case "slug":
			return z.string();

		case "number":
			return z.number();

		case "integer":
			return z.number().int();

		case "boolean":
			// Boolean fields map to `INTEGER` columns (`FIELD_TYPE_TO_COLUMN`
			// in `schema/types.ts`) and `serializeValue` in
			// `database/repositories/content.ts` writes booleans as 0/1.
			// `deserializeValue` never converts them back, so reads return
			// numbers. Coerce the stored 0/1 shape here so a GET → POST
			// round-trip on a boolean field passes validation. Other inputs
			// (strings, other numbers) fall through to `z.boolean()` and
			// produce its standard rejection.
			return z.preprocess((v) => (v === 0 || v === 1 ? Boolean(v) : v), z.boolean());

		case "datetime":
			return z.string().datetime().or(z.string().date());

		case "select": {
			const options = field.validation?.options;
			if (options && options.length > 0) {
				const [first, ...rest] = options;
				return z.enum([first, ...rest]);
			}
			return z.string();
		}

		case "multiSelect": {
			const multiOptions = field.validation?.options;
			if (multiOptions && multiOptions.length > 0) {
				const [first, ...rest] = multiOptions;
				return z.array(z.enum([first, ...rest]));
			}
			return z.array(z.string());
		}

		case "portableText":
			// Portable Text is an array of blocks. We require `_type` because
			// renderers dispatch on it, but `_key` is intentionally optional:
			// it's a UI-layer concern that the editor regenerates on every
			// change (see `PortableTextEditor`), and the rest of this schema
			// uses `.passthrough()` for everything below the top level. Making
			// `_key` strictly required here was an accidentally tight invariant
			// that rejected any seed/import data not authored against the
			// editor (#867 — autosave failures on seeded template content).
			return z.array(
				z
					.object({
						_type: z.string(),
						_key: z.string().optional(),
					})
					.passthrough(),
			);

		case "image":
			return z.object({
				id: z.string(),
				src: z.string().optional(),
				alt: z.string().optional(),
				width: z.number().optional(),
				height: z.number().optional(),
			});

		case "file":
			return z.object({
				id: z.string(),
				src: z.string().optional(),
				filename: z.string().optional(),
				mimeType: z.string().optional(),
				size: z.number().optional(),
			});

		case "reference":
			return z.string(); // Reference ID

		case "json":
			return z.unknown();

		default:
			return z.unknown();
	}
}

/**
 * Apply validation rules to a schema
 */
function applyValidation(schema: ZodTypeAny, field: Field): ZodTypeAny {
	const validation = field.validation;
	if (!validation) return schema;

	// String validations
	if (schema instanceof z.ZodString) {
		let strSchema = schema;
		if (validation.minLength !== undefined) {
			strSchema = strSchema.min(validation.minLength);
		}
		if (validation.maxLength !== undefined) {
			strSchema = strSchema.max(validation.maxLength);
		}
		if (validation.pattern) {
			strSchema = strSchema.regex(new RegExp(validation.pattern));
		}
		return strSchema;
	}

	// Number validations
	if (schema instanceof z.ZodNumber) {
		let numSchema = schema;
		if (validation.min !== undefined) {
			numSchema = numSchema.min(validation.min);
		}
		if (validation.max !== undefined) {
			numSchema = numSchema.max(validation.max);
		}
		return numSchema;
	}

	return schema;
}

/**
 * Schema cache to avoid regenerating schemas on every request
 */
const schemaCache = new Map<string, { schema: z.ZodObject<any>; version: string }>();

/**
 * Get or generate a cached schema for a collection
 */
export function getCachedSchema(
	collection: CollectionWithFields,
	version?: string,
): z.ZodObject<any> {
	const cacheKey = collection.slug;
	const cached = schemaCache.get(cacheKey);

	// If version matches, return cached schema
	if (cached && (!version || cached.version === version)) {
		return cached.schema;
	}

	// Generate new schema
	const schema = generateZodSchema(collection);

	// Cache it
	schemaCache.set(cacheKey, {
		schema,
		version: version || collection.updatedAt,
	});

	return schema;
}

/**
 * Invalidate cached schema for a collection
 */
export function invalidateSchemaCache(slug: string): void {
	schemaCache.delete(slug);
}

/**
 * Clear all cached schemas
 */
export function clearSchemaCache(): void {
	schemaCache.clear();
}

/**
 * Validate data against a collection's schema
 */
export function validateContent(
	collection: CollectionWithFields,
	data: unknown,
): { success: true; data: unknown } | { success: false; errors: z.ZodError } {
	const schema = getCachedSchema(collection);

	const result = schema.safeParse(data);

	if (result.success) {
		return { success: true, data: result.data };
	}

	return { success: false, errors: result.error };
}

/**
 * Generate TypeScript interface from field definitions
 * Used by CLI `emdash types` to generate types
 */
export function generateTypeScript(collection: CollectionWithFields): string {
	const interfaceName = getInterfaceName(collection);
	const lines: string[] = [];

	lines.push(`export interface ${interfaceName} {`);
	lines.push(`  id: string;`);
	lines.push(`  slug: string | null;`);
	lines.push(`  status: string;`);

	for (const field of collection.fields) {
		const tsType = fieldTypeToTypeScript(field);
		const optional = field.required ? "" : "?";
		lines.push(`  ${field.slug}${optional}: ${tsType};`);
	}

	lines.push(`  createdAt: Date;`);
	lines.push(`  updatedAt: Date;`);
	lines.push(`  publishedAt: Date | null;`);
	// Bylines are eagerly loaded by getEmDashCollection/getEmDashEntry
	lines.push(`  bylines?: ContentBylineCredit[];`);
	lines.push(`}`);

	return lines.join("\n");
}

/**
 * Generate a complete types file with module augmentation
 * This produces emdash-env.d.ts content that provides typed query functions
 */
export function generateTypesFile(collections: CollectionWithFields[]): string {
	const lines: string[] = [];

	// Header
	lines.push(`// Generated by EmDash on dev server start`);
	lines.push(`// Do not edit manually`);
	lines.push(``);
	lines.push(`/// <reference types="emdash/locals" />`);
	lines.push(``);

	// Check if we need PortableTextBlock import
	const needsPortableText = collections.some((c) =>
		c.fields.some((f) => f.type === "portableText"),
	);

	// Build imports - ContentBylineCredit is always needed for bylines
	const imports = ["ContentBylineCredit"];
	if (needsPortableText) {
		imports.push("PortableTextBlock");
	}
	lines.push(`import type { ${imports.join(", ")} } from "emdash";`);
	lines.push(``);

	// Generate individual interfaces
	for (const collection of collections) {
		lines.push(generateTypeScript(collection));
		lines.push(``);
	}

	// Generate the Collections interface for module augmentation
	lines.push(`declare module "emdash" {`);
	lines.push(`  interface EmDashCollections {`);
	for (const collection of collections) {
		const interfaceName = getInterfaceName(collection);
		lines.push(`    ${collection.slug}: ${interfaceName};`);
	}
	lines.push(`  }`);
	lines.push(`}`);

	return lines.join("\n");
}

/**
 * Generate schema hash for cache invalidation
 */
export async function generateSchemaHash(collections: CollectionWithFields[]): Promise<string> {
	const str = JSON.stringify(
		collections.map((c) => ({
			slug: c.slug,
			fields: c.fields.map((f) => ({
				slug: f.slug,
				type: f.type,
				required: f.required,
				validation: f.validation,
			})),
		})),
	);
	return hashString(str);
}

/**
 * Map field type to TypeScript type
 */
function fieldTypeToTypeScript(field: Field): string {
	switch (field.type) {
		case "string":
		case "text":
		case "slug":
		case "url":
		case "datetime":
			return "string";

		case "number":
		case "integer":
			return "number";

		case "boolean":
			return "boolean";

		case "select":
			const options = field.validation?.options;
			if (options && options.length > 0) {
				return options.map((o) => `"${o}"`).join(" | ");
			}
			return "string";

		case "multiSelect":
			const multiOptions = field.validation?.options;
			if (multiOptions && multiOptions.length > 0) {
				return `(${multiOptions.map((o) => `"${o}"`).join(" | ")})[]`;
			}
			return "string[]";

		case "portableText":
			return "PortableTextBlock[]";

		case "image":
			return "{ id: string; src?: string; alt?: string; width?: number; height?: number }";

		case "file":
			return "{ id: string; src?: string; filename?: string; mimeType?: string; size?: number }";

		case "reference":
			// Could be enhanced to include the referenced collection type
			return "string";

		case "json":
			return "unknown";

		default:
			return "unknown";
	}
}

/**
 * Convert string to PascalCase (handles slugs, spaces, etc.)
 */
function pascalCase(str: string): string {
	return str
		.split(PASCAL_CASE_SPLIT_PATTERN)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join("");
}

/**
 * Simple singularization - handles common cases
 */
function singularize(str: string): string {
	if (str.endsWith("ies")) {
		return str.slice(0, -3) + "y";
	}
	if (
		str.endsWith("es") &&
		(str.endsWith("sses") || str.endsWith("xes") || str.endsWith("ches") || str.endsWith("shes"))
	) {
		return str.slice(0, -2);
	}
	if (str.endsWith("s") && !str.endsWith("ss")) {
		return str.slice(0, -1);
	}
	return str;
}

/**
 * Get the interface name for a collection
 */
function getInterfaceName(collection: CollectionWithFields): string {
	return pascalCase(collection.labelSingular || singularize(collection.slug));
}
