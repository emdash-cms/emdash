import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { invalidateCollectionCache } from "../../object-cache/index.js";
import {
	BlockTypeRegistry,
	SchemaError,
	invalidateSchemaCache,
	type BlockType,
	type CreateBlockTypeInput,
	type UpdateBlockTypeInput,
} from "../../schema/index.js";
import type { ApiResult } from "../types.js";

export interface BlockTypeListResponse {
	items: BlockType[];
}

export interface BlockTypeResponse {
	item: BlockType;
}

function schemaError(error: SchemaError) {
	return {
		success: false as const,
		error: { code: error.code, message: error.message, details: error.details },
	};
}

async function invalidateConsumers(db: Kysely<Database>, slug: string): Promise<void> {
	const collections = await new BlockTypeRegistry(db).listAffectedCollections(slug);
	for (const collection of collections) {
		invalidateCollectionCache(collection);
		invalidateSchemaCache(collection);
	}
}

export async function handleBlockTypeList(
	db: Kysely<Database>,
): Promise<ApiResult<BlockTypeListResponse>> {
	try {
		return { success: true, data: { items: await new BlockTypeRegistry(db).listBlockTypes() } };
	} catch {
		return {
			success: false,
			error: { code: "SCHEMA_LIST_ERROR", message: "Failed to list block types" },
		};
	}
}

export async function handleBlockTypeGet(
	db: Kysely<Database>,
	slug: string,
): Promise<ApiResult<BlockTypeResponse>> {
	try {
		const item = await new BlockTypeRegistry(db).getBlockType(slug);
		if (!item) {
			return {
				success: false,
				error: { code: "BLOCK_TYPE_NOT_FOUND", message: `Block type '${slug}' not found` },
			};
		}
		return { success: true, data: { item } };
	} catch (error) {
		if (error instanceof SchemaError) return schemaError(error);
		return {
			success: false,
			error: { code: "SCHEMA_GET_ERROR", message: "Failed to get block type" },
		};
	}
}

export async function handleBlockTypeCreate(
	db: Kysely<Database>,
	input: CreateBlockTypeInput,
): Promise<ApiResult<BlockTypeResponse>> {
	try {
		const item = await new BlockTypeRegistry(db).createBlockType(input);
		await invalidateConsumers(db, input.slug);
		return { success: true, data: { item } };
	} catch (error) {
		if (error instanceof SchemaError) return schemaError(error);
		return {
			success: false,
			error: { code: "SCHEMA_CREATE_ERROR", message: "Failed to create block type" },
		};
	}
}

export async function handleBlockTypeUpdate(
	db: Kysely<Database>,
	slug: string,
	input: UpdateBlockTypeInput,
): Promise<ApiResult<BlockTypeResponse>> {
	try {
		const item = await new BlockTypeRegistry(db).updateBlockType(slug, input);
		await invalidateConsumers(db, slug);
		return { success: true, data: { item } };
	} catch (error) {
		if (error instanceof SchemaError) return schemaError(error);
		return {
			success: false,
			error: { code: "SCHEMA_UPDATE_ERROR", message: "Failed to update block type" },
		};
	}
}

export async function handleBlockTypeVersionActivate(
	db: Kysely<Database>,
	slug: string,
	version: number,
	expectedFingerprint: string,
): Promise<ApiResult<BlockTypeResponse>> {
	try {
		const item = await new BlockTypeRegistry(db).activateVersion(
			slug,
			version,
			expectedFingerprint,
		);
		await invalidateConsumers(db, slug);
		return { success: true, data: { item } };
	} catch (error) {
		if (error instanceof SchemaError) return schemaError(error);
		return {
			success: false,
			error: { code: "SCHEMA_UPDATE_ERROR", message: "Failed to activate block type version" },
		};
	}
}
