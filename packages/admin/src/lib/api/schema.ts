/**
 * Schema/collection/field management APIs (Content Type Builder)
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export type FieldType =
	| "string"
	| "text"
	| "url"
	| "number"
	| "integer"
	| "boolean"
	| "datetime"
	| "select"
	| "multiSelect"
	| "portableText"
	| "image"
	| "file"
	| "reference"
	| "json"
	| "slug"
	| "repeater";

export interface SchemaCollection {
	id: string;
	slug: string;
	label: string;
	labelSingular?: string;
	description?: string;
	icon?: string;
	supports: string[];
	source?: string;
	urlPattern?: string;
	hasSeo: boolean;
	commentsEnabled: boolean;
	commentsModeration: "all" | "first_time" | "none";
	commentsClosedAfterDays: number;
	commentsAutoApproveUsers: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SchemaField {
	id: string;
	collectionId: string;
	slug: string;
	label: string;
	type: FieldType;
	columnType: string;
	required: boolean;
	unique: boolean;
	searchable: boolean;
	defaultValue?: unknown;
	validation?: {
		min?: number;
		max?: number;
		minLength?: number;
		maxLength?: number;
		pattern?: string;
		options?: string[];
	};
	widget?: string;
	options?: Record<string, unknown>;
	sortOrder: number;
	createdAt: string;
}

export interface SchemaCollectionWithFields extends SchemaCollection {
	fields: SchemaField[];
}

export interface CreateCollectionInput {
	slug: string;
	label: string;
	labelSingular?: string;
	description?: string;
	icon?: string;
	supports?: string[];
	urlPattern?: string;
	hasSeo?: boolean;
}

export interface UpdateCollectionInput {
	label?: string;
	labelSingular?: string;
	description?: string;
	icon?: string;
	supports?: string[];
	urlPattern?: string;
	hasSeo?: boolean;
	commentsEnabled?: boolean;
	commentsModeration?: "all" | "first_time" | "none";
	commentsClosedAfterDays?: number;
	commentsAutoApproveUsers?: boolean;
}

export interface CreateFieldInput {
	slug: string;
	label: string;
	type: FieldType;
	required?: boolean;
	unique?: boolean;
	searchable?: boolean;
	defaultValue?: unknown;
	validation?: {
		min?: number;
		max?: number;
		minLength?: number;
		maxLength?: number;
		pattern?: string;
		options?: string[];
	};
	widget?: string;
	options?: Record<string, unknown>;
}

export interface UpdateFieldInput {
	label?: string;
	required?: boolean;
	unique?: boolean;
	searchable?: boolean;
	defaultValue?: unknown;
	validation?: {
		min?: number;
		max?: number;
		minLength?: number;
		maxLength?: number;
		pattern?: string;
		options?: string[];
	};
	widget?: string;
	options?: Record<string, unknown>;
	sortOrder?: number;
}

/**
 * Fetch all collections
 */
export async function fetchCollections(): Promise<SchemaCollection[]> {
	const response = await apiFetch(`${API_BASE}/schema/collections`);
	const data = await parseApiResponse<{ items: SchemaCollection[] }>(
		response,
		"Failed to fetch collections",
	);
	return data.items;
}

/**
 * Fetch a single collection with fields
 */
export async function fetchCollection(
	slug: string,
	includeFields = true,
): Promise<SchemaCollectionWithFields> {
	const url = includeFields
		? `${API_BASE}/schema/collections/${slug}?includeFields=true`
		: `${API_BASE}/schema/collections/${slug}`;
	const response = await apiFetch(url);
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`Collection "${slug}" not found`);
		}
		await throwResponseError(response, "Failed to fetch collection");
	}
	const data = await parseApiResponse<{ item: SchemaCollectionWithFields }>(
		response,
		"Failed to fetch collection",
	);
	return data.item;
}

/**
 * Create a collection
 */
export async function createCollection(input: CreateCollectionInput): Promise<SchemaCollection> {
	const response = await apiFetch(`${API_BASE}/schema/collections`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ item: SchemaCollection }>(
		response,
		"Failed to create collection",
	);
	return data.item;
}

/**
 * Update a collection
 */
export async function updateCollection(
	slug: string,
	input: UpdateCollectionInput,
): Promise<SchemaCollection> {
	const response = await apiFetch(`${API_BASE}/schema/collections/${slug}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ item: SchemaCollection }>(
		response,
		"Failed to update collection",
	);
	return data.item;
}

/**
 * Delete a collection
 */
export async function deleteCollection(slug: string, force = false): Promise<void> {
	const url = force
		? `${API_BASE}/schema/collections/${slug}?force=true`
		: `${API_BASE}/schema/collections/${slug}`;
	const response = await apiFetch(url, { method: "DELETE" });
	if (!response.ok) await throwResponseError(response, "Failed to delete collection");
}

/**
 * Fetch fields for a collection
 */
export async function fetchFields(collectionSlug: string): Promise<SchemaField[]> {
	const response = await apiFetch(`${API_BASE}/schema/collections/${collectionSlug}/fields`);
	const data = await parseApiResponse<{ items: SchemaField[] }>(response, "Failed to fetch fields");
	return data.items;
}

/**
 * Create a field
 */
export async function createField(
	collectionSlug: string,
	input: CreateFieldInput,
): Promise<SchemaField> {
	const response = await apiFetch(`${API_BASE}/schema/collections/${collectionSlug}/fields`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ item: SchemaField }>(response, "Failed to create field");
	return data.item;
}

/**
 * Update a field
 */
export async function updateField(
	collectionSlug: string,
	fieldSlug: string,
	input: UpdateFieldInput,
): Promise<SchemaField> {
	const response = await apiFetch(
		`${API_BASE}/schema/collections/${collectionSlug}/fields/${fieldSlug}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	const data = await parseApiResponse<{ item: SchemaField }>(response, "Failed to update field");
	return data.item;
}

/**
 * Delete a field
 */
export async function deleteField(collectionSlug: string, fieldSlug: string): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/schema/collections/${collectionSlug}/fields/${fieldSlug}`,
		{ method: "DELETE" },
	);
	if (!response.ok) await throwResponseError(response, "Failed to delete field");
}

/**
 * Reorder fields
 */
export async function reorderFields(collectionSlug: string, fieldSlugs: string[]): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/schema/collections/${collectionSlug}/fields/reorder`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fieldSlugs }),
		},
	);
	if (!response.ok) await throwResponseError(response, "Failed to reorder fields");
}

// ============================================
// Orphaned Tables
// ============================================

export interface OrphanedTable {
	slug: string;
	tableName: string;
	rowCount: number;
}

/**
 * Fetch orphaned content tables
 */
export async function fetchOrphanedTables(): Promise<OrphanedTable[]> {
	const response = await apiFetch(`${API_BASE}/schema/orphans`);
	const data = await parseApiResponse<{ items: OrphanedTable[] }>(
		response,
		"Failed to fetch orphaned tables",
	);
	return data.items;
}

/**
 * Register an orphaned table as a collection
 */
export async function registerOrphanedTable(
	slug: string,
	options?: {
		label?: string;
		labelSingular?: string;
		description?: string;
	},
): Promise<SchemaCollection> {
	const response = await apiFetch(`${API_BASE}/schema/orphans/${slug}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options || {}),
	});
	const data = await parseApiResponse<{ item: SchemaCollection }>(
		response,
		"Failed to register orphaned table",
	);
	return data.item;
}
