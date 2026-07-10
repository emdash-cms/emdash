/**
 * Byline custom-field schema management API (Discussion #1174, Phase 4).
 *
 * Mirrors the server-side admin endpoints at
 * `/_emdash/api/admin/byline-fields/*`. Mutation responses use the
 * shared `ApiResult<T>` envelope; this client unwraps it via
 * `parseApiResponse` and surfaces typed errors through
 * `throwResponseError` (so the admin client sees the registry's
 * `FIELD_EXISTS` / `TRANSLATABLE_LOCKED` / `REORDER_MISMATCH` messages
 * verbatim).
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The five v1 field types — deliberately narrower than the content-field
 * union. Adding a new type requires server-side changes (`BYLINE_FIELD_TYPES`)
 * + a column in the storage tables; keep this list in lock-step with
 * `packages/core/src/schema/types.ts`.
 */
export type BylineFieldType = "string" | "text" | "url" | "boolean" | "select";

/**
 * v1 validation shape. Only `options` is consumed today (for `select`-type
 * fields); future field types may extend the shape.
 */
export interface BylineFieldValidation {
	options?: string[];
}

export interface BylineFieldDefinition {
	id: string;
	slug: string;
	label: string;
	type: BylineFieldType;
	required: boolean;
	/**
	 * Whether values are stored per-locale (`true`, default) or shared
	 * across all translations of the same byline (`false`). The flag is
	 * locked once value rows exist — see `BylineFieldUsage`.
	 */
	translatable: boolean;
	validation: BylineFieldValidation | null;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

/**
 * Per-table value counts for a field. Backs the destructive-delete confirm
 * dialog and the `translatable` toggle's locked state in the editor.
 */
export interface BylineFieldUsage {
	translatableValueCount: number;
	groupValueCount: number;
	totalAffectedRows: number;
}

export interface CreateBylineFieldInput {
	slug: string;
	label: string;
	type: BylineFieldType;
	required?: boolean;
	translatable?: boolean;
	validation?: BylineFieldValidation | null;
	sortOrder?: number;
}

/**
 * `slug` and `type` are intentionally absent — both are immutable
 * post-create (changing either would invalidate stored values).
 */
export interface UpdateBylineFieldInput {
	label?: string;
	required?: boolean;
	translatable?: boolean;
	validation?: BylineFieldValidation | null;
	sortOrder?: number;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const BASE = `${API_BASE}/admin/byline-fields`;

export async function listBylineFields(): Promise<{ items: BylineFieldDefinition[] }> {
	const response = await apiFetch(BASE);
	return parseApiResponse<{ items: BylineFieldDefinition[] }>(
		response,
		i18n._(msg`Failed to list byline fields`),
	);
}

export async function getBylineFieldUsage(slug: string): Promise<BylineFieldUsage> {
	const response = await apiFetch(`${BASE}/${encodeURIComponent(slug)}/usage`);
	return parseApiResponse<BylineFieldUsage>(
		response,
		i18n._(msg`Failed to read byline field usage`),
	);
}

export async function createBylineField(
	input: CreateBylineFieldInput,
): Promise<BylineFieldDefinition> {
	const response = await apiFetch(BASE, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<BylineFieldDefinition>(
		response,
		i18n._(msg`Failed to create byline field`),
	);
}

export async function updateBylineField(
	slug: string,
	input: UpdateBylineFieldInput,
): Promise<BylineFieldDefinition> {
	const response = await apiFetch(`${BASE}/${encodeURIComponent(slug)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<BylineFieldDefinition>(
		response,
		i18n._(msg`Failed to update byline field`),
	);
}

export async function deleteBylineField(slug: string): Promise<void> {
	const response = await apiFetch(`${BASE}/${encodeURIComponent(slug)}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete byline field`));
}

export async function reorderBylineFields(
	slugs: string[],
): Promise<{ items: BylineFieldDefinition[] }> {
	const response = await apiFetch(`${BASE}/reorder`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ slugs }),
	});
	return parseApiResponse<{ items: BylineFieldDefinition[] }>(
		response,
		i18n._(msg`Failed to reorder byline fields`),
	);
}
