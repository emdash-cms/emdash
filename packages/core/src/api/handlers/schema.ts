/**
 * Schema/collection management handlers
 */

import type { Kysely } from "kysely";

import { RelationRepository, type Relation } from "../../database/repositories/relation.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import { invalidateCollectionCache } from "../../object-cache/index.js";
import {
	SchemaRegistry,
	SchemaError,
	type Collection,
	type Field,
	type CreateCollectionInput,
	type UpdateCollectionInput,
	type CreateFieldInput,
	type UpdateFieldInput,
	type CollectionWithFields,
} from "../../schema/index.js";
import type { ApiResult } from "../types.js";

/** Maximum attempts to allocate a unique relation name for a new reference
 * field: the base `${collection}_${field}` name, then `_2` through `_5`. */
const RELATION_NAME_MAX_ATTEMPTS = 5;

/** True for SQLite UNIQUE / Postgres unique_violation messages — mirrors the
 * fingerprint used in the relations API handler. */
function isUniqueViolation(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	return message.includes("unique") || message.includes("duplicate");
}

/**
 * Create the relation definition backing a new reference field, retrying
 * with a numeric suffix on a name collision. Runs inside the caller's
 * transaction so the relation and the field row it backs commit or roll
 * back together.
 */
export async function createFieldRelation(
	trx: Kysely<Database>,
	collectionSlug: string,
	fieldSlug: string,
	fieldLabel: string,
	targetCollection: string,
): Promise<Relation> {
	const registry = new SchemaRegistry(trx);
	const relations = new RelationRepository(trx);

	const parent = await registry.getCollection(collectionSlug);
	if (!parent) {
		throw new SchemaError(`Collection "${collectionSlug}" not found`, "COLLECTION_NOT_FOUND");
	}

	const baseName = `${collectionSlug}_${fieldSlug}`.slice(0, 63);
	for (let attempt = 0; attempt < RELATION_NAME_MAX_ATTEMPTS; attempt++) {
		const suffix = attempt === 0 ? "" : `_${attempt + 1}`;
		const name = attempt === 0 ? baseName : `${baseName.slice(0, 63 - suffix.length)}${suffix}`;
		try {
			return await relations.create({
				name,
				parentCollection: collectionSlug,
				childCollection: targetCollection,
				parentLabel: parent.labelSingular ?? parent.label,
				childLabel: fieldLabel,
			});
		} catch (error) {
			const isLastAttempt = attempt === RELATION_NAME_MAX_ATTEMPTS - 1;
			if (isLastAttempt || !isUniqueViolation(error)) throw error;
		}
	}
	throw new SchemaError("Could not allocate a unique relation name", "RELATION_NAME_CONFLICT");
}

export interface CollectionListResponse {
	items: Collection[];
}

export interface CollectionResponse {
	item: Collection;
}

export interface CollectionWithFieldsResponse {
	item: CollectionWithFields;
}

export interface FieldListResponse {
	items: Field[];
}

export interface FieldResponse {
	item: Field;
}

/**
 * List all collections
 */
export async function handleSchemaCollectionList(
	db: Kysely<Database>,
): Promise<ApiResult<CollectionListResponse>> {
	try {
		const registry = new SchemaRegistry(db);
		const items = await registry.listCollections();

		return {
			success: true,
			data: { items },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "SCHEMA_LIST_ERROR",
				message: "Failed to list collections",
			},
		};
	}
}

/**
 * Get a collection by slug
 */
export async function handleSchemaCollectionGet(
	db: Kysely<Database>,
	slug: string,
	options?: { includeFields?: boolean },
): Promise<ApiResult<CollectionResponse | CollectionWithFieldsResponse>> {
	try {
		const registry = new SchemaRegistry(db);

		if (options?.includeFields) {
			const item = await registry.getCollectionWithFields(slug);
			if (!item) {
				return {
					success: false,
					error: {
						code: "NOT_FOUND",
						message: `Collection not found: ${slug}`,
					},
				};
			}
			return {
				success: true,
				data: { item },
			};
		}

		const item = await registry.getCollection(slug);
		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Collection not found: ${slug}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "SCHEMA_GET_ERROR",
				message: "Failed to get collection",
			},
		};
	}
}

/**
 * Create a collection
 */
export async function handleSchemaCollectionCreate(
	db: Kysely<Database>,
	input: CreateCollectionInput,
): Promise<ApiResult<CollectionResponse>> {
	try {
		const registry = new SchemaRegistry(db);
		const item = await registry.createCollection(input);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		console.error("[emdash] Failed to create collection:", error);
		return {
			success: false,
			error: {
				code: "SCHEMA_CREATE_ERROR",
				message: "Failed to create collection",
			},
		};
	}
}

/**
 * Update a collection
 */
export async function handleSchemaCollectionUpdate(
	db: Kysely<Database>,
	slug: string,
	input: UpdateCollectionInput,
): Promise<ApiResult<CollectionResponse>> {
	try {
		const registry = new SchemaRegistry(db);
		const item = await registry.updateCollection(slug, input);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		return {
			success: false,
			error: {
				code: "SCHEMA_UPDATE_ERROR",
				message: "Failed to update collection",
			},
		};
	}
}

/**
 * Delete a collection
 */
export async function handleSchemaCollectionDelete(
	db: Kysely<Database>,
	slug: string,
	options?: { force?: boolean },
): Promise<ApiResult<{ success: boolean }>> {
	try {
		const registry = new SchemaRegistry(db);
		await registry.deleteCollection(slug, options);

		return {
			success: true,
			data: { success: true },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		return {
			success: false,
			error: {
				code: "SCHEMA_DELETE_ERROR",
				message: "Failed to delete collection",
			},
		};
	}
}

/**
 * List fields for a collection
 */
export async function handleSchemaFieldList(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<ApiResult<FieldListResponse>> {
	try {
		const registry = new SchemaRegistry(db);
		const collection = await registry.getCollection(collectionSlug);

		if (!collection) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Collection not found: ${collectionSlug}`,
				},
			};
		}

		const items = await registry.listFields(collection.id);

		return {
			success: true,
			data: { items },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "SCHEMA_FIELD_LIST_ERROR",
				message: "Failed to list fields",
			},
		};
	}
}

/**
 * Get a field
 */
export async function handleSchemaFieldGet(
	db: Kysely<Database>,
	collectionSlug: string,
	fieldSlug: string,
): Promise<ApiResult<FieldResponse>> {
	try {
		const registry = new SchemaRegistry(db);
		const item = await registry.getField(collectionSlug, fieldSlug);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Field not found: ${fieldSlug} in collection ${collectionSlug}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "SCHEMA_FIELD_GET_ERROR",
				message: "Failed to get field",
			},
		};
	}
}

/**
 * Create a field
 */
export async function handleSchemaFieldCreate(
	db: Kysely<Database>,
	collectionSlug: string,
	input: CreateFieldInput,
): Promise<ApiResult<FieldResponse>> {
	try {
		if (input.type === "reference") {
			const targetCollection = input.validation?.targetCollection;
			if (!targetCollection) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: "Reference field requires a target collection",
					},
				};
			}

			// The relation def and the field row it backs must commit or roll
			// back together — a field without its relation (or vice versa) is
			// an inconsistent reference field.
			const item = await withTransaction(db, async (trx) => {
				const relation = await createFieldRelation(
					trx,
					collectionSlug,
					input.slug,
					input.label,
					targetCollection,
				);
				const registry = new SchemaRegistry(trx);
				return registry.createField(collectionSlug, {
					...input,
					validation: {
						...input.validation,
						relation: relation.translationGroup,
						targetCollection,
					},
				});
			});

			// Content snapshots embed field values; a column change invalidates them.
			invalidateCollectionCache(collectionSlug);

			return {
				success: true,
				data: { item },
			};
		}

		const registry = new SchemaRegistry(db);
		const item = await registry.createField(collectionSlug, input);

		// Content snapshots embed field values; a column change invalidates them.
		invalidateCollectionCache(collectionSlug);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		return {
			success: false,
			error: {
				code: "SCHEMA_FIELD_CREATE_ERROR",
				message: "Failed to create field",
			},
		};
	}
}

/**
 * Update a field
 */
export async function handleSchemaFieldUpdate(
	db: Kysely<Database>,
	collectionSlug: string,
	fieldSlug: string,
	input: UpdateFieldInput,
): Promise<ApiResult<FieldResponse>> {
	try {
		const lookupRegistry = new SchemaRegistry(db);
		const existing = await lookupRegistry.getField(collectionSlug, fieldSlug);
		const relationGroup =
			existing?.type === "reference" ? existing.validation?.relation : undefined;

		if (existing && relationGroup) {
			// The relation's childCollection is immutable — a reference field's
			// target collection can't change after the relation is wired up.
			const nextTargetCollection = input.validation?.targetCollection;
			if (
				nextTargetCollection !== undefined &&
				nextTargetCollection !== existing.validation?.targetCollection
			) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: "Cannot change the target collection of an existing reference field",
					},
				};
			}

			// `relation` and `targetCollection` are immutable identity for a wired
			// reference field. An update that sends `validation: null` or a partial
			// validation object omitting these keys must not be allowed to clear
			// them -- registry.updateField() writes whatever is passed verbatim,
			// which would otherwise orphan the relation row and its edges.
			const updateInput =
				input.validation !== undefined
					? {
							...input,
							validation: {
								...input.validation,
								relation: existing.validation?.relation,
								targetCollection: existing.validation?.targetCollection,
							},
						}
					: input;

			const item = await withTransaction(db, async (trx) => {
				const registry = new SchemaRegistry(trx);
				const updated = await registry.updateField(collectionSlug, fieldSlug, updateInput);

				if (input.label !== undefined && input.label !== existing.label) {
					const relations = new RelationRepository(trx);
					const siblings = await relations.findTranslations(relationGroup);
					const target = siblings[0];
					if (target) await relations.update(target.id, { childLabel: input.label });
				}

				return updated;
			});

			invalidateCollectionCache(collectionSlug);

			return {
				success: true,
				data: { item },
			};
		}

		const registry = new SchemaRegistry(db);
		const item = await registry.updateField(collectionSlug, fieldSlug, input);

		invalidateCollectionCache(collectionSlug);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		return {
			success: false,
			error: {
				code: "SCHEMA_FIELD_UPDATE_ERROR",
				message: "Failed to update field",
			},
		};
	}
}

/**
 * Delete a field
 */
export async function handleSchemaFieldDelete(
	db: Kysely<Database>,
	collectionSlug: string,
	fieldSlug: string,
): Promise<ApiResult<{ success: boolean }>> {
	try {
		const lookupRegistry = new SchemaRegistry(db);
		const existing = await lookupRegistry.getField(collectionSlug, fieldSlug);
		const relationGroup =
			existing?.type === "reference" ? existing.validation?.relation : undefined;

		if (relationGroup) {
			// The field row and the relation def (plus its edges) it backs must
			// go together — a reference field can't outlive its relation, and a
			// relation left behind after its field is gone is an orphan.
			await withTransaction(db, async (trx) => {
				const registry = new SchemaRegistry(trx);
				const relations = new RelationRepository(trx);
				await registry.deleteField(collectionSlug, fieldSlug);
				const siblings = await relations.findTranslations(relationGroup);
				for (const sibling of siblings) await relations.delete(sibling.id);
			});
		} else {
			const registry = new SchemaRegistry(db);
			await registry.deleteField(collectionSlug, fieldSlug);
		}

		invalidateCollectionCache(collectionSlug);

		return {
			success: true,
			data: { success: true },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		return {
			success: false,
			error: {
				code: "SCHEMA_FIELD_DELETE_ERROR",
				message: "Failed to delete field",
			},
		};
	}
}

/**
 * Reorder fields
 */
export async function handleSchemaFieldReorder(
	db: Kysely<Database>,
	collectionSlug: string,
	fieldSlugs: string[],
): Promise<ApiResult<{ success: boolean }>> {
	try {
		const registry = new SchemaRegistry(db);
		await registry.reorderFields(collectionSlug, fieldSlugs);

		return {
			success: true,
			data: { success: true },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		return {
			success: false,
			error: {
				code: "SCHEMA_FIELD_REORDER_ERROR",
				message: "Failed to reorder fields",
			},
		};
	}
}

// ============================================
// Orphaned Table Discovery
// ============================================

export interface OrphanedTable {
	slug: string;
	tableName: string;
	rowCount: number;
}

export interface OrphanedTableListResponse {
	items: OrphanedTable[];
}

/**
 * List orphaned content tables
 */
export async function handleOrphanedTableList(
	db: Kysely<Database>,
): Promise<ApiResult<OrphanedTableListResponse>> {
	try {
		const registry = new SchemaRegistry(db);
		const items = await registry.discoverOrphanedTables();

		return {
			success: true,
			data: { items },
		};
	} catch (error) {
		console.error("[emdash] Failed to list orphaned tables:", error);
		return {
			success: false,
			error: {
				code: "ORPHAN_LIST_ERROR",
				message: "Failed to list orphaned tables",
			},
		};
	}
}

/**
 * Register an orphaned table as a collection
 */
export async function handleOrphanedTableRegister(
	db: Kysely<Database>,
	slug: string,
	options?: {
		label?: string;
		labelSingular?: string;
		description?: string;
	},
): Promise<ApiResult<CollectionResponse>> {
	try {
		const registry = new SchemaRegistry(db);
		const item = await registry.registerOrphanedTable(slug, options);

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (error instanceof SchemaError) {
			return {
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			};
		}
		return {
			success: false,
			error: {
				code: "ORPHAN_REGISTER_ERROR",
				message: "Failed to register orphaned table",
			},
		};
	}
}
