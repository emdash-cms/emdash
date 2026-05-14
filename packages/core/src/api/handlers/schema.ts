/**
 * Schema/collection management handlers
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
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
		const registry = new SchemaRegistry(db);
		const item = await registry.createField(collectionSlug, input);

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
		const registry = new SchemaRegistry(db);
		const item = await registry.updateField(collectionSlug, fieldSlug, input);

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
		const registry = new SchemaRegistry(db);
		await registry.deleteField(collectionSlug, fieldSlug);

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

/**
 * Reorder collections
 */
export async function handleSchemaCollectionReorder(
	db: Kysely<Database>,
	collections: Array<{ slug: string; sortOrder: number }>,
): Promise<ApiResult<{ success: boolean }>> {
	try {
		const registry = new SchemaRegistry(db);
		await registry.reorderCollections(collections);

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
				code: "SCHEMA_COLLECTION_REORDER_ERROR",
				message: "Failed to reorder collections",
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
