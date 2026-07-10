/**
 * Handler layer for the byline-fields admin API (Phase 4 of Discussion
 * #1174).
 *
 * Each handler:
 * - Takes the `Kysely<Database>` from the route, returns `ApiResult<T>`.
 * - Wraps the registry call in try/catch.
 * - Translates `BylineSchemaError` → shared `ErrorCode` via
 *   `mapBylineSchemaError`. HTTP status comes from `mapErrorStatus` at
 *   the route's `unwrapResult` site — handlers don't know about
 *   statuses.
 * - Catches everything else, logs server-side, returns a 500-class
 *   code without leaking `error.message`.
 *
 * Reserved-slug + identifier validation runs at the zod layer (see
 * `schemas/byline-fields.ts`); the registry repeats it for defence in
 * depth (non-HTTP callers). This module assumes inputs have already
 * passed through whichever zod schema the route used.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import {
	BylineSchemaError,
	BylineSchemaRegistry,
	mapBylineSchemaError,
} from "../../schema/byline-registry.js";
import type {
	BylineFieldDefinition,
	CreateBylineFieldInput,
	UpdateBylineFieldInput,
} from "../../schema/types.js";
import type { ApiResult } from "../types.js";

/**
 * Build a structured failure envelope from a `BylineSchemaError`.
 * Centralised so every handler emits the same shape.
 */
function bylineSchemaErrorResult<T>(error: BylineSchemaError): ApiResult<T> {
	const mapped = mapBylineSchemaError(error);
	return {
		success: false,
		error: { code: mapped.code, message: mapped.message, details: mapped.details },
	};
}

/**
 * Build a 500-class failure envelope. Logs the underlying error
 * server-side; the message returned to the client is the static
 * fallback to avoid leaking internals.
 */
function internalErrorResult<T>(
	error: unknown,
	code: string,
	fallbackMessage: string,
): ApiResult<T> {
	console.error(`[${code}]`, error);
	return {
		success: false,
		error: { code, message: fallbackMessage },
	};
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function handleBylineFieldList(
	db: Kysely<Database>,
): Promise<ApiResult<{ items: BylineFieldDefinition[] }>> {
	try {
		const items = await new BylineSchemaRegistry(db).listFields();
		return { success: true, data: { items } };
	} catch (error) {
		return internalErrorResult(error, "SCHEMA_FIELD_LIST_ERROR", "Failed to list byline fields");
	}
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function handleBylineFieldCreate(
	db: Kysely<Database>,
	input: CreateBylineFieldInput,
): Promise<ApiResult<BylineFieldDefinition>> {
	try {
		const field = await new BylineSchemaRegistry(db).createField(input);
		return { success: true, data: field };
	} catch (error) {
		if (error instanceof BylineSchemaError) {
			return bylineSchemaErrorResult(error);
		}
		return internalErrorResult(error, "SCHEMA_FIELD_CREATE_ERROR", "Failed to create byline field");
	}
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

export async function handleBylineFieldGet(
	db: Kysely<Database>,
	slug: string,
): Promise<ApiResult<BylineFieldDefinition>> {
	try {
		const field = await new BylineSchemaRegistry(db).getField(slug);
		if (!field) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Byline field not found" },
			};
		}
		return { success: true, data: field };
	} catch (error) {
		return internalErrorResult(error, "SCHEMA_FIELD_GET_ERROR", "Failed to get byline field");
	}
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function handleBylineFieldUpdate(
	db: Kysely<Database>,
	slug: string,
	input: UpdateBylineFieldInput,
): Promise<ApiResult<BylineFieldDefinition>> {
	try {
		const field = await new BylineSchemaRegistry(db).updateField(slug, input);
		return { success: true, data: field };
	} catch (error) {
		if (error instanceof BylineSchemaError) {
			return bylineSchemaErrorResult(error);
		}
		return internalErrorResult(error, "SCHEMA_FIELD_UPDATE_ERROR", "Failed to update byline field");
	}
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function handleBylineFieldDelete(
	db: Kysely<Database>,
	slug: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		await new BylineSchemaRegistry(db).deleteField(slug);
		return { success: true, data: { deleted: true } };
	} catch (error) {
		if (error instanceof BylineSchemaError) {
			return bylineSchemaErrorResult(error);
		}
		return internalErrorResult(error, "SCHEMA_FIELD_DELETE_ERROR", "Failed to delete byline field");
	}
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function handleBylineFieldUsage(
	db: Kysely<Database>,
	slug: string,
): Promise<
	ApiResult<{
		translatableValueCount: number;
		groupValueCount: number;
		totalAffectedRows: number;
	}>
> {
	try {
		const usage = await new BylineSchemaRegistry(db).getFieldUsage(slug);
		return { success: true, data: usage };
	} catch (error) {
		if (error instanceof BylineSchemaError) {
			return bylineSchemaErrorResult(error);
		}
		return internalErrorResult(
			error,
			"SCHEMA_FIELD_GET_ERROR",
			"Failed to read byline field usage",
		);
	}
}

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

export async function handleBylineFieldReorder(
	db: Kysely<Database>,
	slugs: string[],
): Promise<ApiResult<{ items: BylineFieldDefinition[] }>> {
	try {
		const registry = new BylineSchemaRegistry(db);
		await registry.reorderFields(slugs);
		const items = await registry.listFields();
		return { success: true, data: { items } };
	} catch (error) {
		if (error instanceof BylineSchemaError) {
			return bylineSchemaErrorResult(error);
		}
		return internalErrorResult(
			error,
			"SCHEMA_FIELD_REORDER_ERROR",
			"Failed to reorder byline fields",
		);
	}
}
