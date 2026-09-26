/**
 * Manifest generation handlers
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { expandCollectionBlockFields } from "../../schema/block-values.js";
import { SchemaRegistry } from "../../schema/registry.js";
import { isStoragelessField, MAX_COLLECTION_LIST_COLUMNS } from "../../schema/types.js";
import type {
	CollectionWithFields,
	Field,
	FieldType,
	FieldValidation,
} from "../../schema/types.js";
import { isMissingTableError } from "../../utils/db-errors.js";
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
/** Field types that can be surfaced as list columns in the admin. */
const LIST_COLUMN_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
	"string",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
]);

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
	blocks: "blocks",
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
		routable?: boolean;
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
			routable: definition.admin.routable ?? true,
			fields,
		};
	}

	if (!db) return manifestCollections;

	try {
		const registry = new SchemaRegistry(db);
		const storedCollections = await registry.listCollectionsWithFields();
		const dbCollections = await Promise.all(
			storedCollections.map((collection) => expandCollectionBlockFields(db, collection)),
		);
		const cardinality = await relationCardinality(db, dbCollections);
		for (const collection of dbCollections) {
			if (manifestCollections[collection.slug]) continue;

			const fields: Record<string, ManifestFieldDescriptor> = {};
			for (const field of collection.fields) {
				fields[field.slug] = dbFieldDescriptor(field, cardinality);
			}

			const configuredListColumns = collection.admin?.listColumns ?? [];
			const fieldTypes = new Map(collection.fields.map((field) => [field.slug, field.type]));
			const listColumns: string[] = [];
			for (const slug of configuredListColumns) {
				if (listColumns.includes(slug)) continue;
				const fieldType = fieldTypes.get(slug);
				if (!fieldType || !LIST_COLUMN_FIELD_TYPES.has(fieldType)) {
					console.warn(
						`EmDash: Ignoring unsupported or unknown list column "${slug}" in collection "${collection.slug}".`,
					);
					continue;
				}
				if (listColumns.length >= MAX_COLLECTION_LIST_COLUMNS) {
					console.warn(
						`EmDash: Collection "${collection.slug}" declares more than ${MAX_COLLECTION_LIST_COLUMNS} list columns; extra columns are ignored.`,
					);
					break;
				}
				listColumns.push(slug);
			}

			manifestCollections[collection.slug] = {
				label: collection.label,
				labelSingular: collection.labelSingular || collection.label,
				supports: collection.supports || [],
				hasSeo: collection.hasSeo,
				urlPattern: collection.urlPattern,
				routable: collection.routable !== false,
				titleField: collection.titleField,
				dateField: collection.dateField,
				...(collection.hidden ? { hidden: true } : {}),
				...(collection.group ? { group: collection.group } : {}),
				listColumns: listColumns.length > 0 ? listColumns : undefined,
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

/** How many entries each end of a relation may hold. `null` is unlimited. */
interface RelationCardinality {
	maxChildrenPerParent: number | null;
	maxParentsPerChild: number | null;
}

/**
 * The limits of every relation a bound reference field names, by relation slug.
 *
 * Empty when nothing is bound, so a site with no reference fields never issues
 * the query, and empty before migration 086 has created the table.
 */
async function relationCardinality(
	db: Kysely<Database>,
	collections: CollectionWithFields[],
): Promise<Map<string, RelationCardinality>> {
	if (!collections.some((collection) => collection.fields.some(isStoragelessField))) {
		return new Map();
	}
	try {
		const rows = await db
			.selectFrom("_emdash_relations")
			.select(["slug", "max_children_per_parent", "max_parents_per_child"])
			.execute();
		return new Map(
			rows.map((row) => [
				row.slug,
				{
					maxChildrenPerParent: row.max_children_per_parent,
					maxParentsPerChild: row.max_parents_per_child,
				},
			]),
		);
	} catch (error) {
		if (isMissingTableError(error)) return new Map();
		throw error;
	}
}

/**
 * Whether the editor may select more than one entry for a bound reference
 * field: the question the relation answers, from the end the field views.
 *
 * `validation.multiple` on the field row is a create-time input — it is what
 * set the relation's limit — and the relation is what the write path enforces.
 * Reading the field back would let the two disagree, which is what happens when
 * a later edit rewrites the row's validation without it.
 */
function boundReferenceIsMultiple(
	validation: FieldValidation,
	cardinality: RelationCardinality,
): boolean {
	const max =
		validation.relationSide === "child"
			? cardinality.maxParentsPerChild
			: cardinality.maxChildrenPerParent;
	return max !== 1;
}

function dbFieldDescriptor(
	field: Field,
	cardinality: Map<string, RelationCardinality>,
): ManifestFieldDescriptor {
	const entry: ManifestFieldDescriptor = {
		kind: field.unsupportedType ? "unsupported" : FIELD_TYPE_TO_KIND[field.type],
		label: field.label,
		required: field.required,
		translatable: field.translatable,
		id: field.id,
	};
	if (field.unsupportedType) entry.unsupportedType = field.unsupportedType;
	if (field.blockTypes) entry.blockTypes = field.blockTypes;
	if (field.blockTypeFingerprint) entry.blockTypeFingerprint = field.blockTypeFingerprint;

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

	if (field.validation) {
		const validation: Record<string, unknown> = { ...field.validation };
		if (isStoragelessField(field) && field.validation.relation) {
			const limits = cardinality.get(field.validation.relation);
			if (limits) validation.multiple = boundReferenceIsMultiple(field.validation, limits);
		}
		entry.validation = validation;
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
