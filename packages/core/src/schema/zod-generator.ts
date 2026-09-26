import { z, type ZodType } from "zod";

import { hashString } from "../utils/hash.js";
import type { BlockFieldDefinition } from "./block-types.js";
import {
	isStoragelessField,
	type CollectionWithFields,
	type Field,
	type FieldType,
	type RepeaterSubField,
} from "./types.js";

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
): z.ZodObject<Record<string, ZodType>> {
	const shape: Record<string, ZodType> = {};

	for (const field of collection.fields) {
		if (isStoragelessField(field)) continue;
		shape[field.slug] = generateFieldSchema(field);
	}

	return z.object(shape);
}

/**
 * Generate Zod schema for a single field
 */
type RuntimeFieldDefinition = Pick<Field, "type" | "validation" | "required" | "defaultValue">;

export function generateFieldSchema(field: RuntimeFieldDefinition): ZodType {
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

export function generateBlockFieldSchema(field: BlockFieldDefinition): ZodType {
	return generateFieldSchema({
		type: field.type,
		validation: field.validation,
		required: field.required ?? false,
		defaultValue: field.defaultValue,
	});
}

/**
 * Get base Zod schema for a field type
 */
function getBaseSchema(type: FieldType, field: Pick<Field, "validation">): ZodType {
	switch (type) {
		case "url":
			return z.string().check(z.url());

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
			return z.iso.datetime({ offset: true }).or(z.iso.datetime({ offset: true, precision: -1 }));

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

		case "repeater":
			return z.array(generateRepeaterRowSchema(field.validation?.subFields ?? []));

		case "blocks":
			return z.array(z.unknown());

		case "portableText":
			// Portable Text is an array of blocks. We require `_type` because
			// renderers dispatch on it, but `_key` is intentionally optional:
			// it's a UI-layer concern that the editor regenerates on every
			// change (see `PortableTextEditor`), and the rest of this schema
			// uses `.loose()` for everything below the top level. Making
			// `_key` strictly required here was an accidentally tight invariant
			// that rejected any seed/import data not authored against the
			// editor (#867 — autosave failures on seeded template content).
			return z.array(
				z
					.object({
						_type: z.string(),
						_key: z.string().optional(),
					})
					.loose(),
			);

		case "image": {
			const mediaSchema = z.object({
				id: z.string(),
				src: z.string().optional(),
				alt: z.string().optional(),
				width: z.number().optional(),
				height: z.number().optional(),
				filename: z.string().optional(),
				mimeType: z.string().optional(),
				blurhash: z.string().optional(),
				dominantColor: z.string().optional(),
				/** Focal point as 0..1 fractions of width and height */
				focalX: z.number().optional(),
				focalY: z.number().optional(),
				/** Provider ID (e.g. "local", "cloudflare-images") */
				provider: z.string().optional(),
				/** Admin-side preview URL for external providers (not persisted by plugins) */
				previewUrl: z.string().optional(),
				/** Provider-specific metadata; for local media this carries storageKey */
				meta: z.record(z.string(), z.unknown()).optional(),
			});
			return mediaSchema.extend({
				/** Counterpart shown when the page renders in a dark color scheme */
				darkVariant: mediaSchema.optional(),
			});
		}

		case "file":
			return z.object({
				id: z.string(),
				url: z.string().optional(),
				src: z.string().optional(),
				filename: z.string().optional(),
				mimeType: z.string().optional(),
				size: z.number().optional(),
				/** Provider ID (e.g. "local", "s3") */
				provider: z.string().optional(),
				/** Provider-specific metadata; for local media this carries storageKey */
				meta: z.record(z.string(), z.unknown()).optional(),
			});

		case "reference":
			return z.string(); // Reference ID

		case "json":
			return z.unknown();

		default:
			return z.unknown();
	}
}

function generateRepeaterRowSchema(
	subFields: readonly RepeaterSubField[],
): z.ZodObject<Record<string, ZodType>> {
	const shape: Record<string, ZodType> = {};

	for (const subField of subFields) {
		let schema = getBaseSchema(subField.type, {
			validation: subField.options ? { options: subField.options } : undefined,
		});

		if (subField.required && schema instanceof z.ZodString) {
			schema = schema.min(1, "required (empty value not allowed)");
		}
		if (!subField.required) {
			schema = schema.nullish();
		}

		shape[subField.slug] = schema;
	}

	return z.object(shape).loose();
}

/**
 * Apply validation rules to a schema
 */
function applyValidation(
	schema: ZodType,
	field: Pick<RuntimeFieldDefinition, "type" | "validation">,
): ZodType {
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

	if ((field.type === "repeater" || field.type === "blocks") && schema instanceof z.ZodArray) {
		let arraySchema = schema;
		if (validation.minItems !== undefined) {
			arraySchema = arraySchema.min(validation.minItems);
		}
		if (validation.maxItems !== undefined) {
			arraySchema = arraySchema.max(validation.maxItems);
		}
		return arraySchema;
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
export function generateTypeScript(
	collection: CollectionWithFields,
	interfaceName: string = getInterfaceName(collection),
	blockFieldTypes: ReadonlyMap<string, string> = new Map(),
): string {
	const lines: string[] = [];

	lines.push(`export interface ${interfaceName} {`);
	lines.push(`  id: string;`);
	lines.push(`  slug: string | null;`);
	lines.push(`  status: string;`);

	for (const field of collection.fields) {
		// A storage-less field holds no value in `data`; a reference field bound to
		// a relation resolves through `references` instead. One that predates
		// relations still owns its column, so it stays an entry id string.
		if (isStoragelessField(field)) continue;
		const tsType = blockFieldTypes.get(field.slug) ?? fieldTypeToTypeScript(field);
		const optional = field.required ? "" : "?";
		lines.push(`  ${field.slug}${optional}: ${tsType};`);
	}

	lines.push(`  createdAt: Date;`);
	lines.push(`  updatedAt: Date;`);
	lines.push(`  publishedAt: Date | null;`);
	// Bylines are eagerly loaded by getEmDashCollection/getEmDashEntry
	lines.push(`  byline?: BylineSummary | null;`);
	lines.push(`  bylines?: ContentBylineCredit[];`);
	// Taxonomy terms are eagerly loaded by getEmDashCollection/getEmDashEntry,
	// keyed by taxonomy name (e.g. data.terms?.tag)
	lines.push(`  terms?: Record<string, TaxonomyTerm[]>;`);
	lines.push(`}`);

	return lines.join("\n");
}

function generateBlockTypeDeclarations(
	collection: CollectionWithFields,
	interfaceName: string,
): { lines: string[]; fieldTypes: Map<string, string> } {
	const lines: string[] = [];
	const fieldTypes = new Map<string, string>();
	for (const field of collection.fields) {
		if (field.type !== "blocks") continue;
		const fieldName = `${interfaceName}${pascalCase(field.slug)}`;
		const typeNames: string[] = [];
		for (const blockType of field.blockTypes ?? []) {
			const typeName = `${fieldName}${pascalCase(blockType.slug)}`;
			const versionNames: string[] = [];
			for (const version of blockType.versions) {
				const versionName = `${typeName}V${version.version}Block`;
				versionNames.push(versionName);
				lines.push(`export interface ${versionName} {`);
				lines.push(`  _type: ${JSON.stringify(blockType.slug)};`);
				lines.push(`  _version: ${version.version};`);
				lines.push(`  _key: string;`);
				for (const nestedField of version.fields) {
					const nestedType = fieldTypeToTypeScript({
						type: nestedField.type,
						validation: nestedField.validation,
					});
					const name = JSON.stringify(nestedField.slug);
					lines.push(
						nestedField.required
							? `  ${name}: ${nestedType};`
							: `  ${name}?: ${nestedType} | null;`,
					);
				}
				lines.push(`}`);
				lines.push(``);
			}
			const unionName = `${typeName}Block`;
			lines.push(`export type ${unionName} = ${versionNames.join(" | ") || "never"};`);
			lines.push(``);
			typeNames.push(unionName);
		}
		const fieldUnion = `${fieldName}Block`;
		lines.push(`export type ${fieldUnion} = ${typeNames.join(" | ") || "never"};`);
		lines.push(``);
		fieldTypes.set(field.slug, `${fieldUnion}[]`);
	}
	return { lines, fieldTypes };
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
	const needsPortableText = collections.some((collection) =>
		collection.fields.some(
			(field) =>
				field.type === "portableText" ||
				field.blockTypes?.some((blockType) =>
					blockType.versions.some((version) =>
						version.fields.some((nestedField) => nestedField.type === "portableText"),
					),
				),
		),
	);

	const withReferences = collections.filter((c) => c.fields.some(isStoragelessField));

	// Build imports - BylineSummary, ContentBylineCredit and TaxonomyTerm are always needed
	// for the hydrated bylines/terms fields
	const imports = ["BylineSummary", "ContentBylineCredit", "TaxonomyTerm"];
	if (needsPortableText) {
		imports.push("PortableTextBlock");
	}
	if (withReferences.length > 0) {
		imports.push("ReferencePage");
	}
	lines.push(`import type { ${imports.join(", ")} } from "emdash";`);
	lines.push(``);

	// Singularizing the slug can map two distinct slugs to the same name
	// (e.g. `book` and `books` both -> `Book`), so resolve collisions up front
	// to keep every interface identifier unique within the file.
	const interfaceNames = uniqueInterfaceNames(collections);
	// `{Collection}References`, built on an already-unique name. No slug can
	// produce a data interface name ending in `References` -- `singularize`
	// always strips the trailing `s` of a final `references` segment -- so the
	// suffix cannot collide with one.
	const referenceInterfaces: [CollectionWithFields, string][] = withReferences.map((c) => [
		c,
		`${interfaceNames.get(c.slug)}References`,
	]);

	// Generate individual interfaces
	for (const collection of collections) {
		const interfaceName = interfaceNames.get(collection.slug) ?? getInterfaceName(collection);
		const blocks = generateBlockTypeDeclarations(collection, interfaceName);
		lines.push(...blocks.lines);
		lines.push(generateTypeScript(collection, interfaceName, blocks.fieldTypes));
		lines.push(``);
	}

	for (const [collection, name] of referenceInterfaces) {
		lines.push(generateReferencesTypeScript(collection, name, interfaceNames));
		lines.push(``);
	}

	// Generate the Collections interface for module augmentation
	lines.push(`declare module "emdash" {`);
	lines.push(`  interface EmDashCollections {`);
	for (const collection of collections) {
		lines.push(`    ${collection.slug}: ${interfaceNames.get(collection.slug)};`);
	}
	lines.push(`  }`);
	if (referenceInterfaces.length > 0) {
		lines.push(`  interface EmDashCollectionReferences {`);
		for (const [collection, name] of referenceInterfaces) {
			lines.push(`    ${collection.slug}: ${name};`);
		}
		lines.push(`  }`);
	}
	lines.push(`}`);

	return lines.join("\n");
}

/**
 * Generate the references interface for one collection: a page per reference
 * field bound to a relation, keyed by field slug, which is how
 * `getEmDashEntry({ references })` both asks for and returns them.
 *
 * A field is always present on the interface, not optional -- a selection that
 * names it always yields a page, empty when nothing is linked. The narrowing in
 * `getEmDashEntry` picks out the fields the caller asked for.
 */
function generateReferencesTypeScript(
	collection: CollectionWithFields,
	interfaceName: string,
	interfaceNames: Map<string, string>,
): string {
	const lines: string[] = [`export interface ${interfaceName} {`];

	for (const field of collection.fields) {
		if (!isStoragelessField(field)) continue;
		// A target outside this file (dropped collection, or a relation whose
		// other end has not been created) leaves the page's data un-narrowed
		// rather than referring to an identifier that does not exist.
		const target = field.validation?.targetCollection;
		const targetName = target ? interfaceNames.get(target) : undefined;
		lines.push(`  ${field.slug}: ReferencePage${targetName ? `<${targetName}>` : ""};`);
	}

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
				blockTypeFingerprint: f.blockTypeFingerprint,
			})),
		})),
	);
	return hashString(str);
}

/**
 * Map field type to TypeScript type
 */
function fieldTypeToTypeScript(field: {
	type: Field["type"];
	validation?: Field["validation"];
}): string {
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

		case "repeater": {
			const subFields = field.validation?.subFields;
			// `validation` is unvalidated JSON on the seed and registry paths.
			if (!Array.isArray(subFields) || subFields.length === 0) return "unknown";

			// A duplicated slug keeps its first position and last declaration, as
			// `generateRepeaterRowSchema`'s `shape[subField.slug]` does.
			const members = new Map<string, string>();

			for (const subField of subFields) {
				const type = fieldTypeToTypeScript({
					type: subField.type,
					validation: subField.options ? { options: subField.options } : undefined,
				});
				// A sub-field slug is not guaranteed to be a valid identifier, so it is
				// quoted rather than emitted bare.
				const name = JSON.stringify(subField.slug);
				// A sub-field that is not required may be null at runtime.
				members.set(
					subField.slug,
					subField.required ? `${name}: ${type}` : `${name}?: ${type} | null`,
				);
			}

			return `{ ${[...members.values()].join("; ")} }[]`;
		}

		case "portableText":
			return "PortableTextBlock[]";

		case "image": {
			const media =
				"{ id: string; src?: string; alt?: string; width?: number; height?: number; filename?: string; mimeType?: string; blurhash?: string; dominantColor?: string; focalX?: number; focalY?: number; provider?: string; previewUrl?: string; meta?: Record<string, unknown> }";
			return `${media.slice(0, -2)}; darkVariant?: ${media} }`;
		}

		case "file":
			return "{ id: string; url?: string; src?: string; filename?: string; mimeType?: string; size?: number; provider?: string; meta?: Record<string, unknown> }";

		case "reference":
			// Could be enhanced to include the referenced collection type
			return "string";

		case "json":
			return "unknown";

		case "blocks":
			return "unknown[]";

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
 * Naive singularization for slug-derived interface names. Handles the common
 * English plural endings; intentionally simple, not a full inflector.
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
 * Get the interface name for a collection.
 *
 * Derived from the slug, not the human label. Slugs are constrained to
 * `/^[a-z][a-z0-9_]*$/`, so PascalCasing one always yields a valid TS
 * identifier; labels are arbitrary and user-controlled (punctuation, spaces,
 * duplicates across collections), which produced syntactically invalid or
 * duplicate interface names. The slug is singularized first because the
 * interface describes a single entry, not the collection (`posts` -> `Post`).
 *
 * Singularization can map two distinct slugs onto the same name, so callers
 * generating more than one interface must dedupe -- see `uniqueInterfaceNames`.
 */
function getInterfaceName(collection: CollectionWithFields): string {
	return pascalCase(singularize(collection.slug));
}

/**
 * Resolve interface names for a set of collections, guaranteeing each is
 * unique within the file. Collisions (from singularization or PascalCasing
 * collapsing distinct slugs) get a numeric suffix in collection order, so the
 * generated `.d.ts` never declares two interfaces with the same identifier.
 *
 * The suffix is chosen against the set of names already emitted, not a
 * per-base counter, so a generated name can't collide with another slug's
 * base name (e.g. slugs `book`, `books`, `book2`: `books` -> `Book2` would
 * clash with `book2`, so it advances to `Book3`).
 */
export function uniqueInterfaceNames(collections: CollectionWithFields[]): Map<string, string> {
	const used = new Set<string>();
	const names = new Map<string, string>();
	for (const collection of collections) {
		const base = getInterfaceName(collection);
		let name = base;
		let suffix = 2;
		while (used.has(name)) {
			name = `${base}${suffix}`;
			suffix++;
		}
		used.add(name);
		names.set(collection.slug, name);
	}
	return names;
}
