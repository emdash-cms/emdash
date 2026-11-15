import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { SchemaError, SchemaRegistry } from "../schema/registry.js";
import type { CreateFieldInput, Field, FieldValidation } from "../schema/types.js";

const PRODUCT_COLLECTION_SLUG = "products";

const PRODUCT_DETAILS_VALIDATION: FieldValidation = {
	subFields: [{ slug: "text", type: "text", label: "Text", required: true }],
	maxItems: 20,
};

const PRODUCT_FIELD_DEFINITIONS: readonly CreateFieldInput[] = [
	{
		slug: "sku",
		label: "SKU",
		type: "string",
		required: false,
		unique: true,
		indexed: true,
		translatable: false,
	},
	{
		slug: "short_description",
		label: "Short description",
		type: "text",
		required: false,
	},
	{
		slug: "product_details",
		label: "Product details",
		type: "repeater",
		required: false,
		validation: PRODUCT_DETAILS_VALIDATION,
	},
];

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value !== "object" || value === null) return value;

	return Object.fromEntries(
		Object.entries(value)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalize(entry)]),
	);
}

function definitionsMatch(existing: Field, expected: CreateFieldInput): boolean {
	return (
		existing.type === expected.type &&
		existing.required === (expected.required ?? false) &&
		existing.unique === (expected.unique ?? false) &&
		existing.indexed === (expected.indexed ?? false) &&
		existing.translatable === (expected.translatable ?? true) &&
		JSON.stringify(canonicalize(existing.validation ?? null)) ===
			JSON.stringify(canonicalize(expected.validation ?? null))
	);
}

/**
 * Add the built-in presentation fields to an existing products collection.
 *
 * Existing fields are never changed or removed. An existing field with the
 * same slug must match the required storage and validation contract.
 */
export async function ensureShopProductFields(db: Kysely<Database>): Promise<void> {
	const registry = new SchemaRegistry(db);
	const collection = await registry.getCollectionWithFields(PRODUCT_COLLECTION_SLUG);
	if (!collection) return;

	const existingBySlug = new Map(collection.fields.map((field) => [field.slug, field]));
	for (const definition of PRODUCT_FIELD_DEFINITIONS) {
		const existing = existingBySlug.get(definition.slug);
		if (existing && !definitionsMatch(existing, definition)) {
			throw new SchemaError(
				`Field "${definition.slug}" in collection "${PRODUCT_COLLECTION_SLUG}" has an incompatible definition`,
				"INCOMPATIBLE_FIELD_DEFINITION",
				{
					collection: PRODUCT_COLLECTION_SLUG,
					field: definition.slug,
					expected: definition,
					actual: existing,
				},
			);
		}
	}

	for (const definition of PRODUCT_FIELD_DEFINITIONS) {
		if (!existingBySlug.has(definition.slug)) {
			await registry.createField(PRODUCT_COLLECTION_SLUG, definition);
		}
	}
}
