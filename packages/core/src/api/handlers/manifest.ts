/**
 * Manifest generation handlers
 */

import { hashString } from "../../utils/hash.js";
import type { ManifestResponse, FieldDescriptor } from "../types.js";

/** Pattern to add spaces before capital letters */
const CAMEL_CASE_PATTERN = /([A-Z])/g;
const FIRST_CHAR_PATTERN = /^./;

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
): Promise<ManifestResponse> {
	const manifestCollections: ManifestResponse["collections"] = {};

	for (const [name, definition] of Object.entries(collections)) {
		// Extract field descriptors from Zod schema
		const fields = extractFieldDescriptors(definition.schema);

		manifestCollections[name] = {
			label: definition.admin.label,
			labelSingular: definition.admin.labelSingular || definition.admin.label,
			supports: definition.admin.supports || [],
			fields,
		};
	}

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
 * Extract field descriptors from Zod schema
 * Note: This is a simplified implementation that handles common types
 */
function extractFieldDescriptors(schema: {
	_def?: { shape?: () => Record<string, unknown> };
	shape?: Record<string, unknown>;
}): Record<string, FieldDescriptor> {
	const fields: Record<string, FieldDescriptor> = {};

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
	if (schema.isDateOnly) {
		return { kind: "date", label: formatLabel(name) };
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

/**
 * Format field name as label
 */
function formatLabel(name: string): string {
	return name
		.replace(CAMEL_CASE_PATTERN, " $1")
		.replace(FIRST_CHAR_PATTERN, (str) => str.toUpperCase())
		.trim();
}
