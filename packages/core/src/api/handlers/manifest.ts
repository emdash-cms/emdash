/**
 * Manifest generation handlers
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { SchemaRegistry } from "../../schema/registry.js";
import type { Field, FieldType } from "../../schema/types.js";
import { hashString } from "../../utils/hash.js";
import type {
	FieldDescriptor,
	ManifestCollectionMap,
	ManifestFieldDescriptor,
	ManifestResponse,
} from "../types.js";

/** Pattern to add spaces before capital letters */
const CAMEL_CASE_PATTERN = /([A-Z])/g;
const FIRST_CHAR_PATTERN = /^./;

/**
 * Map schema field types to editor field kinds.
 */
const FIELD_TYPE_TO_KIND: Record<FieldType, string> = {
	string: "string",
	slug: "string",
	url: "url",
	text: "richText",
	number: "number",
	integer: "number",
	boolean: "boolean",
	datetime: "datetime",
	select: "select",
	multiSelect: "multiSelect",
	portableText: "portableText",
	image: "image",
	file: "file",
	reference: "reference",
	json: "json",
	repeater: "repeater",
};

// Collection definition shape for manifest generation
interface CollectionDefinition {
	schema: {
		_def?: { shape?: () => Record<string, unknown> };
		shape?: Record<string, unknown>;
	};
	admin: {
		label: string;
		labelSingular?: string;
		supports?: string[];
	};
}
type CollectionMap = Record<string, CollectionDefinition>;

interface GenerateManifestOptions {
	db?: Kysely<Database> | null;
}

/**
 * Generate admin manifest from collections
 */
export async function generateManifest(
	collections: CollectionMap,
	plugins: Record<
		string,
		{
			adminPages?: Array<{ path: string; component: string }>;
			widgets?: string[];
		}
	> = {},
	options: GenerateManifestOptions = {},
): Promise<ManifestResponse> {
	const manifestCollections = await buildManifestCollections(collections, options.db);

	// Generate hash from collections (for cache invalidation)
	const hash = await hashString(JSON.stringify(manifestCollections));

	return {
		version: "0.1.0",
		hash,
		collections: manifestCollections,
		plugins,
	};
}

/**
 * Build collection descriptors from build-time config plus live database rows.
 *
 * Config collections are added first and win on slug conflicts. Runtime/manual
 * collections have no Zod schema to inspect, so their field descriptors are
 * synthesized from `_emdash_fields`.
 */
export async function buildManifestCollections(
	collections: CollectionMap,
	db?: Kysely<Database> | null,
): Promise<ManifestCollectionMap> {
	const manifestCollections: ManifestCollectionMap = {};

	for (const [name, definition] of Object.entries(collections)) {
		// Extract field descriptors from Zod schema
		const fields = extractFieldDescriptors(definition.schema);

		manifestCollections[name] = {
			label: definition.admin.label,
			labelSingular: definition.admin.labelSingular || definition.admin.label,
			supports: definition.admin.supports || [],
			hasSeo: (definition.admin.supports || []).includes("seo"),
			fields,
		};
	}

	if (!db) return manifestCollections;

	try {
		const registry = new SchemaRegistry(db);
		const dbCollections = await registry.listCollectionsWithFields();
		for (const collection of dbCollections) {
			if (manifestCollections[collection.slug]) continue;

			const fields: Record<string, ManifestFieldDescriptor> = {};
			for (const field of collection.fields) {
				fields[field.slug] = dbFieldDescriptor(field);
			}

			manifestCollections[collection.slug] = {
				label: collection.label,
				labelSingular: collection.labelSingular || collection.label,
				supports: collection.supports || [],
				hasSeo: collection.hasSeo,
				urlPattern: collection.urlPattern,
				fields,
			};
		}
	} catch (error) {
		console.debug("EmDash: Could not load database collections for manifest:", error);
	}

	return manifestCollections;
}

/**
 * Extract field descriptors from Zod schema
 * Note: This is a simplified implementation that handles common types
 */
function extractFieldDescriptors(schema: {
	_def?: { shape?: () => Record<string, unknown> };
	shape?: Record<string, unknown>;
}): Record<string, ManifestFieldDescriptor> {
	const fields: Record<string, ManifestFieldDescriptor> = {};

	// Handle Zod object schema
	const shape = typeof schema._def?.shape === "function" ? schema._def.shape() : schema.shape || {};

	for (const [name, fieldSchema] of Object.entries(shape)) {
		fields[name] = extractFieldType(name, fieldSchema);
	}

	return fields;
}

/**
 * Extract field type from Zod schema
 */
/** Type guard: check if a value is a non-null object */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractFieldType(name: string, schema: unknown): FieldDescriptor {
	if (!isObject(schema)) {
		return { kind: "string", label: formatLabel(name) };
	}

	// Check for custom field markers
	if (schema.isPortableText) {
		return { kind: "portableText", label: formatLabel(name) };
	}
	if (schema.isImage) {
		return { kind: "image", label: formatLabel(name) };
	}
	if (schema.isReference) {
		return { kind: "reference", label: formatLabel(name) };
	}

	// Handle standard Zod types
	const def = isObject(schema._def) ? schema._def : undefined;
	const typeName = typeof def?.typeName === "string" ? def.typeName : undefined;

	switch (typeName) {
		case "ZodString":
			return { kind: "string", label: formatLabel(name) };
		case "ZodNumber":
			return { kind: "number", label: formatLabel(name) };
		case "ZodBoolean":
			return { kind: "boolean", label: formatLabel(name) };
		case "ZodDate":
			return { kind: "datetime", label: formatLabel(name) };
		case "ZodEnum": {
			const values = Array.isArray(def?.values) ? def.values : [];
			return {
				kind: "select",
				label: formatLabel(name),
				options: values
					.filter((v): v is string => typeof v === "string")
					.map((v) => ({
						value: v,
						label: v.charAt(0).toUpperCase() + v.slice(1),
					})),
			};
		}
		case "ZodArray":
			return { kind: "array", label: formatLabel(name) };
		case "ZodObject":
			return { kind: "object", label: formatLabel(name) };
		case "ZodOptional":
		case "ZodDefault":
			// Unwrap optional/default types
			if (def?.innerType) {
				return extractFieldType(name, def.innerType);
			}
			return { kind: "string", label: formatLabel(name) };
		default:
			return { kind: "string", label: formatLabel(name) };
	}
}

function dbFieldDescriptor(field: Field): ManifestFieldDescriptor {
	const entry: ManifestFieldDescriptor = {
		kind: FIELD_TYPE_TO_KIND[field.type] ?? "string",
		label: field.label,
		required: field.required,
		id: field.id,
	};

	if (field.widget) entry.widget = field.widget;
	if (field.options) entry.options = field.options;

	// Legacy: select/multiSelect enum options live on `field.validation.options`.
	// They win over widget options to preserve existing select behavior.
	if (field.validation?.options) {
		entry.options = field.validation.options.map((value) => ({
			value,
			label: value.charAt(0).toUpperCase() + value.slice(1),
		}));
	}

	// Include validation only for field widgets that need it client-side.
	if (
		(field.type === "repeater" || field.type === "file" || field.type === "image") &&
		field.validation
	) {
		entry.validation = { ...field.validation } as Record<string, unknown>;
	}

	return entry;
}

/**
 * Format field name as label
 */
function formatLabel(name: string): string {
	return name
		.replace(CAMEL_CASE_PATTERN, " $1")
		.replace(FIRST_CHAR_PATTERN, (str) => str.toUpperCase())
		.trim();
}
