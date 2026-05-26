import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type FindManyResult,
} from "./client.js";

export interface BylineSummary {
	id: string;
	slug: string;
	displayName: string;
	bio: string | null;
	avatarMediaId: string | null;
	websiteUrl: string | null;
	userId: string | null;
	isGuest: boolean;
	createdAt: string;
	updatedAt: string;
	/** Locale this byline row is presented in (migration 040). */
	locale: string;
	/**
	 * Shared across translations of the same byline (migration 040).
	 * Nullable for backwards compatibility; new rows always populate it.
	 */
	translationGroup: string | null;
}

export interface BylineInput {
	slug: string;
	displayName: string;
	bio?: string | null;
	avatarMediaId?: string | null;
	websiteUrl?: string | null;
	userId?: string | null;
	isGuest?: boolean;
	/**
	 * Locale this byline row belongs to. When omitted, the server uses the
	 * configured `defaultLocale`.
	 */
	locale?: string;
	/**
	 * When set, the new row joins the source byline's `translation_group`.
	 * Requires `locale` (the server returns a validation error otherwise).
	 */
	translationOf?: string;
}

export interface BylineTranslationInput {
	locale: string;
	slug?: string;
	displayName?: string;
	bio?: string | null;
	avatarMediaId?: string | null;
	websiteUrl?: string | null;
}

export interface BylineCreditInput {
	bylineId: string;
	roleLabel?: string | null;
}

export async function fetchBylines(options?: {
	search?: string;
	isGuest?: boolean;
	userId?: string;
	locale?: string;
	cursor?: string;
	limit?: number;
}): Promise<FindManyResult<BylineSummary>> {
	const params = new URLSearchParams();
	if (options?.search) params.set("search", options.search);
	if (options?.isGuest !== undefined) params.set("isGuest", String(options.isGuest));
	if (options?.userId) params.set("userId", options.userId);
	if (options?.locale) params.set("locale", options.locale);
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));

	const url = `${API_BASE}/admin/bylines${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<BylineSummary>>(response, "Failed to fetch bylines");
}

export async function fetchByline(id: string): Promise<BylineSummary> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}`);
	return parseApiResponse<BylineSummary>(response, "Failed to fetch byline");
}

export async function createByline(input: BylineInput): Promise<BylineSummary> {
	const response = await apiFetch(`${API_BASE}/admin/bylines`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<BylineSummary>(response, "Failed to create byline");
}

export async function updateByline(
	id: string,
	input: Partial<BylineInput>,
): Promise<BylineSummary> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<BylineSummary>(response, "Failed to update byline");
}

export async function deleteByline(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete byline`));
}

/**
 * Fetch every translation of a byline (siblings sharing the same
 * translation_group).
 */
export async function fetchBylineTranslations(id: string): Promise<{ items: BylineSummary[] }> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}/translations`);
	return parseApiResponse<{ items: BylineSummary[] }>(
		response,
		"Failed to fetch byline translations",
	);
}

/**
 * Create a new locale variant of a byline. The new row joins the source's
 * `translation_group`. Body defaults — slug, display name, avatar, website —
 * inherit from the source when omitted, so editors only have to fill in the
 * localized bio (and optionally a localized display name).
 */
export async function createBylineTranslation(
	id: string,
	input: BylineTranslationInput,
): Promise<BylineSummary> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}/translations`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<BylineSummary>(response, "Failed to create byline translation");
}
