/**
 * Content CRUD and revision APIs
 */

import type { BylineCreditInput, BylineSummary } from "./bylines.js";
import {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type FindManyResult,
} from "./client.js";

/**
 * Derive draft status from a content item's revision pointers
 */
export function getDraftStatus(
	item: ContentItem,
): "unpublished" | "published" | "published_with_changes" {
	if (!item.liveRevisionId) return "unpublished";
	if (item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId)
		return "published_with_changes";
	return "published";
}

/** SEO metadata for a content item */
export interface ContentSeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

export interface ContentItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	locale: string;
	translationGroup: string | null;
	data: Record<string, unknown>;
	authorId: string | null;
	primaryBylineId: string | null;
	byline?: BylineSummary | null;
	bylines?: Array<{
		byline: BylineSummary;
		sortOrder: number;
		roleLabel: string | null;
	}>;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	scheduledAt: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	seo?: ContentSeo;
}

export interface CreateContentInput {
	type: string;
	slug?: string;
	data: Record<string, unknown>;
	status?: string;
	bylines?: BylineCreditInput[];
	locale?: string;
	translationOf?: string;
}

export interface TranslationSummary {
	id: string;
	locale: string;
	slug: string | null;
	status: string;
	updatedAt: string;
}

export interface TranslationsResponse {
	translationGroup: string;
	translations: TranslationSummary[];
}

/**
 * Fetch translations for a content item
 */
export async function fetchTranslations(
	collection: string,
	id: string,
): Promise<TranslationsResponse> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/translations`);
	return parseApiResponse<TranslationsResponse>(response, "Failed to fetch translations");
}

/** Input for updating SEO fields on content */
export interface ContentSeoInput {
	title?: string | null;
	description?: string | null;
	image?: string | null;
	canonical?: string | null;
	noIndex?: boolean;
}

export interface UpdateContentInput {
	data?: Record<string, unknown>;
	slug?: string;
	status?: string;
	authorId?: string | null;
	bylines?: BylineCreditInput[];
	/** Skip revision creation (used by autosave) */
	skipRevision?: boolean;
	seo?: ContentSeoInput;
}

/**
 * Trashed content item with deletion timestamp
 */
export interface TrashedContentItem extends ContentItem {
	deletedAt: string;
}

/**
 * Preview URL response
 */
export interface PreviewUrlResponse {
	url: string;
	expiresAt: number;
}

/**
 * Fetch content list
 */
export async function fetchContentList(
	collection: string,
	options?: {
		cursor?: string;
		limit?: number;
		status?: string;
		locale?: string;
		/** Field name to order by, matching the server's whitelist. */
		orderBy?: string;
		/** Sort direction; defaults to "desc" on the server. */
		order?: "asc" | "desc";
	},
): Promise<FindManyResult<ContentItem>> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.status) params.set("status", options.status);
	if (options?.locale) params.set("locale", options.locale);
	if (options?.orderBy) params.set("orderBy", options.orderBy);
	if (options?.order) params.set("order", options.order);

	const url = `${API_BASE}/content/${collection}${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<ContentItem>>(response, "Failed to fetch content");
}

/**
 * Fetch single content item
 */
export async function fetchContent(collection: string, id: string): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}`);
	const data = await parseApiResponse<{ item: ContentItem }>(response, "Failed to fetch content");
	return data.item;
}

/**
 * Create content
 */
export async function createContent(
	collection: string,
	input: Omit<CreateContentInput, "type">,
): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			data: input.data,
			slug: input.slug,
			status: input.status,
			bylines: input.bylines,
			locale: input.locale,
			translationOf: input.translationOf,
		}),
	});
	const data = await parseApiResponse<{ item: ContentItem }>(response, "Failed to create content");
	return data.item;
}

/**
 * Update content
 */
export async function updateContent(
	collection: string,
	id: string,
	input: UpdateContentInput,
): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ item: ContentItem }>(response, "Failed to update content");
	return data.item;
}

/**
 * Delete content (moves to trash)
 */
export async function deleteContent(collection: string, id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete content");
}

/**
 * Fetch trashed content list
 */
export async function fetchTrashedContent(
	collection: string,
	options?: {
		cursor?: string;
		limit?: number;
	},
): Promise<FindManyResult<TrashedContentItem>> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));

	const url = `${API_BASE}/content/${collection}/trash${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<TrashedContentItem>>(
		response,
		"Failed to fetch trashed content",
	);
}

/**
 * Restore content from trash
 */
export async function restoreContent(collection: string, id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/restore`, {
		method: "POST",
	});
	if (!response.ok) await throwResponseError(response, "Failed to restore content");
}

/**
 * Permanently delete content (cannot be undone)
 */
export async function permanentDeleteContent(collection: string, id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/permanent`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to permanently delete content");
}

/**
 * Duplicate content (creates a draft copy)
 */
export async function duplicateContent(collection: string, id: string): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/duplicate`, {
		method: "POST",
	});
	const data = await parseApiResponse<{ item: ContentItem }>(
		response,
		"Failed to duplicate content",
	);
	return data.item;
}

/**
 * Schedule content for future publishing
 */
export async function scheduleContent(
	collection: string,
	id: string,
	scheduledAt: string,
): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/schedule`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scheduledAt }),
	});
	const data = await parseApiResponse<{ item: ContentItem }>(
		response,
		"Failed to schedule content",
	);
	return data.item;
}

/**
 * Unschedule content (revert to draft)
 */
export async function unscheduleContent(collection: string, id: string): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/schedule`, {
		method: "DELETE",
	});
	const data = await parseApiResponse<{ item: ContentItem }>(
		response,
		"Failed to unschedule content",
	);
	return data.item;
}

/**
 * Get a preview URL for content
 *
 * Returns a signed URL that allows viewing draft content.
 * Returns null if preview is not configured (missing EMDASH_PREVIEW_SECRET).
 */
export async function getPreviewUrl(
	collection: string,
	id: string,
	options?: {
		expiresIn?: string;
		pathPattern?: string;
	},
): Promise<PreviewUrlResponse | null> {
	try {
		const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/preview-url`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(options || {}),
		});

		if (response.status === 500) {
			// Preview not configured — check error code without consuming body for parseApiResponse
			const body: unknown = await response.json().catch(() => ({}));
			if (
				typeof body === "object" &&
				body !== null &&
				"error" in body &&
				typeof body.error === "object" &&
				body.error !== null &&
				"code" in body.error &&
				body.error.code === "NOT_CONFIGURED"
			) {
				return null;
			}
			// Some other 500 error
			throw new Error("Failed to get preview URL");
		}

		return parseApiResponse<PreviewUrlResponse>(response, "Failed to get preview URL");
	} catch {
		// If preview endpoint doesn't exist or fails, return null
		return null;
	}
}

// =============================================================================
// Publishing (Draft Revisions)
// =============================================================================

/**
 * Publish content - promotes current draft to live
 */
export async function publishContent(collection: string, id: string): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/publish`, {
		method: "POST",
	});
	const data = await parseApiResponse<{ item: ContentItem }>(response, "Failed to publish content");
	return data.item;
}

/**
 * Unpublish content - removes from public, preserves draft
 */
export async function unpublishContent(collection: string, id: string): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/unpublish`, {
		method: "POST",
	});
	const data = await parseApiResponse<{ item: ContentItem }>(
		response,
		"Failed to unpublish content",
	);
	return data.item;
}

/**
 * Discard draft changes - reverts to live version
 */
export async function discardDraft(collection: string, id: string): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/discard-draft`, {
		method: "POST",
	});
	const data = await parseApiResponse<{ item: ContentItem }>(response, "Failed to discard draft");
	return data.item;
}

/**
 * Compare live and draft revisions
 */
export async function compareRevisions(
	collection: string,
	id: string,
): Promise<{
	hasChanges: boolean;
	live: Record<string, unknown> | null;
	draft: Record<string, unknown> | null;
}> {
	const response = await apiFetch(`${API_BASE}/content/${collection}/${id}/compare`);
	return parseApiResponse<{
		hasChanges: boolean;
		live: Record<string, unknown> | null;
		draft: Record<string, unknown> | null;
	}>(response, "Failed to compare revisions");
}

// =============================================================================
// Revision API
// =============================================================================

export interface Revision {
	id: string;
	collection: string;
	entryId: string;
	data: Record<string, unknown>;
	authorId: string | null;
	createdAt: string;
}

export interface RevisionListResponse {
	items: Revision[];
	total: number;
}

/**
 * Fetch revisions for a content item
 */
export async function fetchRevisions(
	collection: string,
	entryId: string,
	options?: { limit?: number },
): Promise<RevisionListResponse> {
	const params = new URLSearchParams();
	if (options?.limit) params.set("limit", String(options.limit));

	const url = `${API_BASE}/content/${collection}/${entryId}/revisions${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<RevisionListResponse>(response, "Failed to fetch revisions");
}

/**
 * Get a specific revision
 */
export async function fetchRevision(revisionId: string): Promise<Revision> {
	const response = await apiFetch(`${API_BASE}/revisions/${revisionId}`);

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`Revision not found: ${revisionId}`);
		}
		await throwResponseError(response, "Failed to fetch revision");
	}

	const data = await parseApiResponse<{ item: Revision }>(response, "Failed to fetch revision");
	return data.item;
}

/**
 * Restore a revision (updates content to this revision's data)
 */
export async function restoreRevision(revisionId: string): Promise<ContentItem> {
	const response = await apiFetch(`${API_BASE}/revisions/${revisionId}/restore`, {
		method: "POST",
	});

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`Revision not found: ${revisionId}`);
		}
		await throwResponseError(response, "Failed to restore revision");
	}

	const data = await parseApiResponse<{ item: ContentItem }>(
		response,
		"Failed to restore revision",
	);
	return data.item;
}
