/**
 * Sections API (reusable content blocks)
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export type SectionSource = "theme" | "user" | "import";

export interface Section {
	id: string;
	slug: string;
	title: string;
	description?: string;
	keywords: string[];
	content: unknown[]; // Portable Text
	previewUrl?: string;
	source: SectionSource;
	themeId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateSectionInput {
	slug: string;
	title: string;
	description?: string;
	keywords?: string[];
	content: unknown[];
	previewMediaId?: string;
}

export interface UpdateSectionInput {
	slug?: string;
	title?: string;
	description?: string;
	keywords?: string[];
	content?: unknown[];
	previewMediaId?: string | null;
}

export interface GetSectionsOptions {
	source?: SectionSource;
	search?: string;
	limit?: number;
	cursor?: string;
}

export interface SectionsResult {
	items: Section[];
	nextCursor?: string;
}

/**
 * Fetch all sections
 */
export async function fetchSections(options?: GetSectionsOptions): Promise<SectionsResult> {
	const params = new URLSearchParams();
	if (options?.source) params.set("source", options.source);
	if (options?.search) params.set("search", options.search);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.cursor) params.set("cursor", options.cursor);

	const url = params.toString() ? `${API_BASE}/sections?${params}` : `${API_BASE}/sections`;
	const response = await apiFetch(url);
	return parseApiResponse<SectionsResult>(response, "Failed to fetch sections");
}

/**
 * Fetch a single section by slug
 */
export async function fetchSection(slug: string): Promise<Section> {
	const response = await apiFetch(`${API_BASE}/sections/${slug}`);
	return parseApiResponse<Section>(response, "Failed to fetch section");
}

/**
 * Create a section
 */
export async function createSection(input: CreateSectionInput): Promise<Section> {
	const response = await apiFetch(`${API_BASE}/sections`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<Section>(response, "Failed to create section");
}

/**
 * Update a section
 */
export async function updateSection(slug: string, input: UpdateSectionInput): Promise<Section> {
	const response = await apiFetch(`${API_BASE}/sections/${slug}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<Section>(response, "Failed to update section");
}

/**
 * Delete a section
 */
export async function deleteSection(slug: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/sections/${slug}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete section`));
}
