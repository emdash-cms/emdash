/**
 * Taxonomies API (categories, tags, custom taxonomies).
 *
 * All endpoints are locale-aware. When no `locale` option is passed we omit
 * the query param and the server falls back to its usual resolution (no
 * filter, returning every locale — same as pre-i18n behaviour for clients
 * that haven't yet been updated).
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface TaxonomyTerm {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId?: string;
	description?: string;
	children: TaxonomyTerm[];
	count?: number;
	locale: string;
	translationGroup: string | null;
}

export interface TaxonomyDef {
	id: string;
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	collections: string[];
	locale: string;
	translationGroup: string | null;
}

export interface TermTranslation {
	id: string;
	slug: string;
	label: string;
	locale: string;
}

export interface TermTranslationsResponse {
	translationGroup: string | null;
	translations: TermTranslation[];
}

export interface TaxonomyDefTranslation {
	id: string;
	name: string;
	label: string;
	locale: string;
}

export interface TaxonomyDefTranslationsResponse {
	translationGroup: string | null;
	translations: TaxonomyDefTranslation[];
}

export interface CreateTaxonomyInput {
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical?: boolean;
	collections?: string[];
	locale?: string;
	translationOf?: string;
}

export interface CreateTermInput {
	slug: string;
	label: string;
	parentId?: string;
	description?: string;
	locale?: string;
	translationOf?: string;
}

export interface UpdateTermInput {
	slug?: string;
	label?: string;
	parentId?: string;
	description?: string;
}

export interface LocaleOptions {
	locale?: string;
}

function withLocale(path: string, locale?: string): string {
	return locale
		? `${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(locale)}`
		: path;
}

/**
 * Fetch all taxonomy definitions
 */
export async function fetchTaxonomyDefs(options: LocaleOptions = {}): Promise<TaxonomyDef[]> {
	const response = await apiFetch(withLocale(`${API_BASE}/taxonomies`, options.locale));
	const data = await parseApiResponse<{ taxonomies: TaxonomyDef[] }>(
		response,
		"Failed to fetch taxonomies",
	);
	return data.taxonomies;
}

/**
 * Fetch taxonomy definition by name
 */
export async function fetchTaxonomyDef(
	name: string,
	options: LocaleOptions = {},
): Promise<TaxonomyDef | null> {
	const defs = await fetchTaxonomyDefs(options);
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
 * Fetch terms for a taxonomy
 */
export async function fetchTerms(
	taxonomyName: string,
	options: LocaleOptions = {},
): Promise<TaxonomyTerm[]> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/taxonomies/${taxonomyName}/terms`, options.locale),
	);
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
	options: LocaleOptions = {},
): Promise<TaxonomyTerm> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/taxonomies/${taxonomyName}/terms/${slug}`, options.locale),
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	const data = await parseApiResponse<{ term: TaxonomyTerm }>(response, "Failed to update term");
	return data.term;
}

/**
 * Delete a term
 */
export async function deleteTerm(
	taxonomyName: string,
	slug: string,
	options: LocaleOptions = {},
): Promise<void> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/taxonomies/${taxonomyName}/terms/${slug}`, options.locale),
		{ method: "DELETE" },
	);
	if (!response.ok) await throwResponseError(response, "Failed to delete term");
}

/** List every translation (locale variant) of a term. */
export async function fetchTermTranslations(
	taxonomyName: string,
	slug: string,
	options: LocaleOptions = {},
): Promise<TermTranslationsResponse> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/taxonomies/${taxonomyName}/terms/${slug}/translations`, options.locale),
	);
	return parseApiResponse<TermTranslationsResponse>(response, "Failed to fetch term translations");
}

/**
 * Create a new locale translation of a term. The new term inherits slug,
 * label, parent, and description from the source unless overridden in `input`.
 */
export async function createTermTranslation(
	taxonomyName: string,
	slug: string,
	input: { locale: string; label?: string; slug?: string },
	options: LocaleOptions = {},
): Promise<TaxonomyTerm> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/taxonomies/${taxonomyName}/terms/${slug}/translations`, options.locale),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	const data = await parseApiResponse<{ term: TaxonomyTerm }>(
		response,
		"Failed to create term translation",
	);
	return data.term;
}
