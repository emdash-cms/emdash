/**
 * Taxonomies API (categories, tags, custom taxonomies)
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface TaxonomyFieldDef {
	name: string;
	label: string;
	type: "string" | "text" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "image" | "file" | "reference" | "json" | "url" | "color";
	required?: boolean;
	options?: Array<{ value: string; label: string }>;
	widget?: string;
	validation?: {
		min?: number;
		max?: number;
		minLength?: number;
		maxLength?: number;
		pattern?: string;
	};
	defaultValue?: unknown;
}

export interface TermSeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

export interface TaxonomyTerm {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId?: string;
	description?: string;
	data?: Record<string, unknown>;
	seo?: TermSeo;
	children: TaxonomyTerm[];
	count?: number;
}

export interface TaxonomyDef {
	id: string;
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	collections: string[];
	fields?: TaxonomyFieldDef[];
	supports?: string[];
	hasSeo?: boolean;
}

export interface CreateTaxonomyInput {
	name: string;
	label: string;
	hierarchical?: boolean;
	collections?: string[];
	fields?: TaxonomyFieldDef[];
	supports?: string[];
	hasSeo?: boolean;
}

export interface UpdateTaxonomyInput {
	label?: string;
	hierarchical?: boolean;
	collections?: string[];
	fields?: TaxonomyFieldDef[];
	supports?: string[];
	hasSeo?: boolean;
}

export interface CreateTermInput {
	slug: string;
	label: string;
	parentId?: string;
	description?: string;
	data?: Record<string, unknown>;
}

export interface UpdateTermInput {
	slug?: string;
	label?: string;
	parentId?: string;
	description?: string;
	data?: Record<string, unknown>;
	seo?: Partial<TermSeo>;
}

/**
 * Fetch all taxonomy definitions
 */
export async function fetchTaxonomyDefs(): Promise<TaxonomyDef[]> {
	const response = await apiFetch(`${API_BASE}/taxonomies`);
	const data = await parseApiResponse<{ taxonomies: TaxonomyDef[] }>(
		response,
		"Failed to fetch taxonomies",
	);
	return data.taxonomies;
}

/**
 * Fetch taxonomy definition by name
 */
export async function fetchTaxonomyDef(name: string): Promise<TaxonomyDef | null> {
	const defs = await fetchTaxonomyDefs();
	return defs.find((t) => t.name === name) || null;
}

/**
 * Create a custom taxonomy definition
 */
export async function createTaxonomy(input: CreateTaxonomyInput): Promise<TaxonomyDef> {
	const response = await apiFetch(`${API_BASE}/taxonomies`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ taxonomy: TaxonomyDef }>(
		response,
		"Failed to create taxonomy",
	);
	return data.taxonomy;
}

/**
 * Update a taxonomy definition
 */
export async function updateTaxonomy(
	name: string,
	input: UpdateTaxonomyInput,
): Promise<TaxonomyDef> {
	const response = await apiFetch(`${API_BASE}/taxonomies/${name}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ taxonomy: TaxonomyDef }>(
		response,
		"Failed to update taxonomy",
	);
	return data.taxonomy;
}

/**
 * Delete a taxonomy definition
 */
export async function deleteTaxonomy(name: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/taxonomies/${name}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete taxonomy");
}

/**
 * Fetch terms for a taxonomy
 */
export async function fetchTerms(taxonomyName: string): Promise<TaxonomyTerm[]> {
	const response = await apiFetch(`${API_BASE}/taxonomies/${taxonomyName}/terms`);
	const data = await parseApiResponse<{ terms: TaxonomyTerm[] }>(response, "Failed to fetch terms");
	return data.terms;
}

/**
 * Create a term
 */
export async function createTerm(
	taxonomyName: string,
	input: CreateTermInput,
): Promise<TaxonomyTerm> {
	const response = await apiFetch(`${API_BASE}/taxonomies/${taxonomyName}/terms`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ term: TaxonomyTerm }>(response, "Failed to create term");
	return data.term;
}

/**
 * Update a term
 */
export async function updateTerm(
	taxonomyName: string,
	slug: string,
	input: UpdateTermInput,
): Promise<TaxonomyTerm> {
	const response = await apiFetch(`${API_BASE}/taxonomies/${taxonomyName}/terms/${slug}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ term: TaxonomyTerm }>(response, "Failed to update term");
	return data.term;
}

/**
 * Delete a term
 */
export async function deleteTerm(taxonomyName: string, slug: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/taxonomies/${taxonomyName}/terms/${slug}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete term");
}
