/**
 * Relations API (reference field definitions and edges).
 */

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface RelationDef {
	id: string;
	name: string;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	childLabel: string;
	locale: string;
	translationGroup: string;
}

export interface EntryRef {
	id: string;
	slug: string | null;
	collection: string;
	locale: string | null;
	sortOrder?: number;
}

export interface ReferencePageOptions {
	cursor?: string;
	limit?: number;
}

/**
 * Fetch all relation definitions.
 */
export async function fetchRelations(locale?: string): Promise<RelationDef[]> {
	const qs = locale ? `?locale=${encodeURIComponent(locale)}` : "";
	const response = await apiFetch(`${API_BASE}/relations${qs}`);
	const data = await parseApiResponse<{ relations: RelationDef[] }>(
		response,
		"Failed to fetch relations",
	);
	return data.relations;
}

function buildPageQuery(opts: ReferencePageOptions = {}): string {
	const params = new URLSearchParams();
	if (opts.cursor) params.set("cursor", opts.cursor);
	if (opts.limit) params.set("limit", String(opts.limit));
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

/**
 * Fetch the children of an entry for a given relation (parent side).
 */
export async function fetchReferenceChildren(
	collection: string,
	id: string,
	relation: string,
	opts: ReferencePageOptions = {},
): Promise<{ children: EntryRef[]; nextCursor?: string }> {
	const qs = buildPageQuery(opts);
	const response = await apiFetch(
		`${API_BASE}/content/${collection}/${id}/references/${relation}/children${qs}`,
	);
	return parseApiResponse<{ children: EntryRef[]; nextCursor?: string }>(
		response,
		"Failed to fetch reference children",
	);
}

/**
 * Fetch the parents of an entry for a given relation (child side).
 */
export async function fetchReferenceParents(
	collection: string,
	id: string,
	relation: string,
	opts: ReferencePageOptions = {},
): Promise<{ parents: EntryRef[]; nextCursor?: string }> {
	const qs = buildPageQuery(opts);
	const response = await apiFetch(
		`${API_BASE}/content/${collection}/${id}/references/${relation}/parents${qs}`,
	);
	return parseApiResponse<{ parents: EntryRef[]; nextCursor?: string }>(
		response,
		"Failed to fetch reference parents",
	);
}
