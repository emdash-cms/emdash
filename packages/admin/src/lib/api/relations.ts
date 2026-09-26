/**
 * Relations API (reference field definitions and links).
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

/** Which end of a relation a reference field picks from. */
export type RelationSide = "parent" | "child";

export interface RelationDef {
	id: string;
	slug: string;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	parentLabelSingular: string | null;
	childLabel: string;
	childLabelSingular: string | null;
	/** How many children one parent may hold. `null` means unlimited. */
	maxChildrenPerParent: number | null;
	/** How many parents one child may hold. `null` means unlimited. */
	maxParentsPerChild: number | null;
}

/** A reference field that views a relation, and which end it views it from. */
export interface BoundField {
	collectionSlug: string;
	fieldSlug: string;
	side: RelationSide;
}

/**
 * A relation plus what deleting it would take with it. Every delete dialog
 * enumerates these before the user confirms.
 */
export interface RelationWithUsage extends RelationDef {
	boundFields: BoundField[];
	linkCount: number;
}

export interface CreateRelationInput {
	slug: string;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	parentLabelSingular?: string | null;
	childLabel: string;
	childLabelSingular?: string | null;
	maxChildrenPerParent?: number | null;
	maxParentsPerChild?: number | null;
}

/** The two collections are immutable once a relation exists; only labels and
 * limits can be updated. */
export interface UpdateRelationInput {
	parentLabel?: string;
	parentLabelSingular?: string | null;
	childLabel?: string;
	childLabelSingular?: string | null;
	maxChildrenPerParent?: number | null;
	maxParentsPerChild?: number | null;
}

export interface EntryRef {
	id: string;
	slug: string | null;
	collection: string;
	/** Display label from the entry's title/name field; null when neither is set. */
	title: string | null;
	locale: string | null;
	/** The translation group `id` resolved from — locale-stable entry identity. */
	translationGroup: string | null;
	sortOrder?: number;
}

export interface ReferencePageOptions {
	cursor?: string;
	limit?: number;
}

/**
 * Fetch relation definitions, optionally only those `collection` takes part in.
 */
export async function fetchRelations(
	opts: { collection?: string } = {},
): Promise<RelationWithUsage[]> {
	const qs = opts.collection ? `?collection=${encodeURIComponent(opts.collection)}` : "";
	const response = await apiFetch(`${API_BASE}/relations${qs}`);
	const data = await parseApiResponse<{ relations: RelationWithUsage[] }>(
		response,
		"Failed to fetch relations",
	);
	return data.relations;
}

/**
 * Fetch one relation by id.
 */
export async function fetchRelation(id: string): Promise<RelationWithUsage> {
	const response = await apiFetch(`${API_BASE}/relations/${encodeURIComponent(id)}`);
	const data = await parseApiResponse<{ relation: RelationWithUsage }>(
		response,
		"Failed to fetch relation",
	);
	return data.relation;
}

export async function createRelation(input: CreateRelationInput): Promise<RelationDef> {
	const response = await apiFetch(`${API_BASE}/relations`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ relation: RelationDef }>(
		response,
		"Failed to create relation",
	);
	return data.relation;
}

export async function updateRelation(id: string, input: UpdateRelationInput): Promise<RelationDef> {
	const response = await apiFetch(`${API_BASE}/relations/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ relation: RelationDef }>(
		response,
		"Failed to update relation",
	);
	return data.relation;
}

/**
 * Delete a relation, its links, and every reference field bound to it.
 */
export async function deleteRelation(id: string): Promise<string[]> {
	const response = await apiFetch(`${API_BASE}/relations/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	const data = await parseApiResponse<{ deleted: true; deletedFields: string[] }>(
		response,
		i18n._(msg`Failed to delete relation`),
	);
	return data.deletedFields;
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
