/**
 * Media upload, list, delete, and provider APIs
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type FindManyResult,
} from "./client.js";

export const MEDIA_SEARCH_MAX_LENGTH = 200;

export interface MediaUploadOptions {
	signal?: AbortSignal;
}

export interface UploadMediaOptions extends MediaUploadOptions {
	fieldId?: string;
	deduplicate?: boolean;
	ensureUniqueFilename?: boolean;
	folderId?: string | null;
}

/** Trim and clamp a search term to the server-accepted range. */
export function normalizeMediaSearch(value: string | undefined | null): string {
	return (value ?? "").trim().slice(0, MEDIA_SEARCH_MAX_LENGTH);
}

export type MediaUsageCoverageStatus =
	| "complete"
	| "never"
	| "running"
	| "partial"
	| "failed"
	| "stale"
	| "unknown";

export interface MediaUsageCoverage {
	scope: "all_content_collections";
	status: MediaUsageCoverageStatus;
}

export interface MediaUsageOccurrenceDetail {
	fieldSlug: string;
	fieldPath: string;
	occurrenceIndex: number;
	referenceType: "image_field" | "file_field" | "portable_text_image" | "unknown";
}

export interface MediaUsageSourceDetail {
	variant: "columns" | "draft_overlay";
	occurrences: MediaUsageOccurrenceDetail[];
}

export interface MediaUsageEntryDetail {
	collection: string;
	contentId: string;
	title: string | null;
	slug: string | null;
	locale: string | null;
	status: string | null;
	scheduledAt: string | null;
	deletedAt: string | null;
	sources: MediaUsageSourceDetail[];
}

export interface MediaUsageDetailsResponse {
	items: MediaUsageEntryDetail[];
	nextCursor?: string;
	coverage: MediaUsageCoverage;
}

export class MediaUsageAccessDeniedError extends Error {
	constructor() {
		super("Media usage details are unavailable");
		this.name = "MediaUsageAccessDeniedError";
	}
}

export interface MediaItem {
	id: string;
	filename: string;
	mimeType: string;
	url: string;
	/** Storage key for local media (e.g., "01ABC.jpg"). Not present for external URLs. */
	storageKey?: string;
	contentHash?: string | null;
	size: number;
	width?: number;
	height?: number;
	focalX?: number | null;
	focalY?: number | null;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
	alt?: string;
	caption?: string;
	createdAt: string;
	status?: "pending" | "ready" | "failed";
	/** Provider ID for external media (e.g., "cloudflare-images") */
	provider?: string;
	/** Provider-specific metadata */
	meta?: Record<string, unknown>;
}

export interface LocalMediaItem extends MediaItem {
	provider?: undefined;
	storageKey: string;
	authorId: string | null;
	folderId: string | null;
}

export interface MediaFolder {
	id: string;
	name: string;
}

export interface MediaListResult extends FindManyResult<LocalMediaItem> {
	totalCount?: number;
}

export interface MediaFolderListResult extends FindManyResult<MediaFolder> {}

/**
 * Fetch media list
 */
export async function fetchMediaList(options?: {
	cursor?: string;
	page?: number;
	limit?: number;
	mimeType?: string | string[];
	folderId?: string | null;
	/** Case-insensitive filename substring search (also matches extensions). */
	search?: string;
}): Promise<MediaListResult> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.page !== undefined) params.set("page", String(options.page));
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.mimeType) {
		const value = Array.isArray(options.mimeType) ? options.mimeType.join(",") : options.mimeType;
		if (value) params.set("mimeType", value);
	}
	if (options?.folderId === null) {
		params.set("folderId", "unfiled");
	} else if (options?.folderId !== undefined) {
		params.set("folderId", options.folderId);
	}
	if (options?.search) {
		// Trim and clamp to the server's accepted range so a long or
		// whitespace-only term can't trigger an avoidable 400.
		const q = normalizeMediaSearch(options.search);
		if (q) params.set("q", q);
	}

	const url = `${API_BASE}/media${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<MediaListResult>(response, i18n._(msg`Failed to fetch media`));
}

/**
 * Fetch a single media item by id.
 *
 * Used to resolve an id-only reference (e.g. a byline's `avatarMediaId`)
 * back into a full media item for display.
 */
export async function fetchMediaItem(
	id: string,
	options?: MediaUploadOptions,
): Promise<LocalMediaItem> {
	const response = await apiFetch(`${API_BASE}/media/${encodeURIComponent(id)}`, {
		signal: options?.signal,
	});
	const data = await parseApiResponse<{ item: LocalMediaItem }>(
		response,
		i18n._(msg`Failed to fetch media item`),
	);
	return data.item;
}

export async function fetchMediaUsageDetails(
	mediaId: string,
	options?: { cursor?: string; limit?: number; signal?: AbortSignal },
): Promise<MediaUsageDetailsResponse> {
	const params = new URLSearchParams();
	if (options?.cursor !== undefined) params.set("cursor", options.cursor);
	if (options?.limit !== undefined) params.set("limit", String(options.limit));

	const query = params.toString();
	const response = await apiFetch(
		`${API_BASE}/media/${encodeURIComponent(mediaId)}/usage${query ? `?${query}` : ""}`,
		{ signal: options?.signal },
	);
	if (response.status === 401 || response.status === 403) {
		throw new MediaUsageAccessDeniedError();
	}
	return parseApiResponse<MediaUsageDetailsResponse>(
		response,
		i18n._(msg`Failed to fetch media usage details`),
	);
}

export async function fetchMediaFolders(
	options: { limit?: number; cursor?: string; search?: string } = {},
): Promise<MediaFolderListResult> {
	const params = new URLSearchParams();
	if (options.limit !== undefined) params.set("limit", String(options.limit));
	if (options.cursor !== undefined) params.set("cursor", options.cursor);
	const search = normalizeMediaSearch(options.search);
	if (search) params.set("q", search);
	const query = params.toString();
	const response = await apiFetch(`${API_BASE}/media/folders${query ? `?${query}` : ""}`);
	return parseApiResponse<MediaFolderListResult>(
		response,
		i18n._(msg`Failed to fetch media folders`),
	);
}

export async function fetchMediaFolder(id: string): Promise<MediaFolder> {
	const response = await apiFetch(`${API_BASE}/media/folders/${encodeURIComponent(id)}`);
	const data = await parseApiResponse<{ item: MediaFolder }>(
		response,
		i18n._(msg`Failed to fetch media folder`),
	);
	return data.item;
}

export async function createMediaFolder(name: string): Promise<MediaFolder> {
	const response = await apiFetch(`${API_BASE}/media/folders`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	});
	const data = await parseApiResponse<{ item: MediaFolder }>(
		response,
		i18n._(msg`Failed to create media folder`),
	);
	return data.item;
}

export async function renameMediaFolder(id: string, name: string): Promise<MediaFolder> {
	const response = await apiFetch(`${API_BASE}/media/folders/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	});
	const data = await parseApiResponse<{ item: MediaFolder }>(
		response,
		i18n._(msg`Failed to rename media folder`),
	);
	return data.item;
}

export async function deleteMediaFolder(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/media/folders/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete media folder`));
}

/**
 * Upload URL response from the API
 */
interface UploadUrlResponse {
	uploadUrl: string;
	method: "PUT";
	headers: Record<string, string>;
	mediaId: string;
	storageKey: string;
	expiresAt: string;
}

interface ExistingMediaResponse {
	existing: true;
	mediaId: string;
	storageKey: string;
	url: string;
}

const MAX_CLIENT_HASH_BYTES = 8 * 1024 * 1024;

async function computeContentHash(file: File, signal?: AbortSignal): Promise<string | undefined> {
	signal?.throwIfAborted();
	const subtle = globalThis.crypto?.subtle;
	if (!subtle || file.size === 0 || file.size > MAX_CLIENT_HASH_BYTES) return undefined;
	try {
		const bytes = await file.arrayBuffer();
		signal?.throwIfAborted();
		const hash = await subtle.digest("SHA-1", bytes);
		signal?.throwIfAborted();
		const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
		return `sha1:${hex}`;
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

/**
 * Try to get a signed upload URL
 * Returns null if signed URLs are not supported (e.g., local storage)
 */
async function getUploadUrl(
	file: File,
	opts?: UploadMediaOptions,
): Promise<UploadUrlResponse | ExistingMediaResponse | null> {
	try {
		const contentHash =
			opts?.deduplicate === false ? undefined : await computeContentHash(file, opts?.signal);
		const response = await apiFetch(`${API_BASE}/media/upload-url`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: opts?.signal,
			body: JSON.stringify({
				filename: file.name,
				contentType: file.type,
				size: file.size,
				...(contentHash ? { contentHash } : {}),
				...(opts?.fieldId ? { fieldId: opts.fieldId } : {}),
				...(opts?.deduplicate === false ? { deduplicate: false } : {}),
				...(opts?.ensureUniqueFilename ? { ensureUniqueFilename: true } : {}),
				...(opts?.folderId !== undefined ? { folderId: opts.folderId } : {}),
			}),
		});

		if (response.status === 501) {
			// Not implemented - storage doesn't support signed URLs
			return null;
		}

		return parseApiResponse<UploadUrlResponse | ExistingMediaResponse>(
			response,
			i18n._(msg`Failed to get upload URL`),
		);
	} catch (error) {
		opts?.signal?.throwIfAborted();
		// If the endpoint doesn't exist, fall back to direct upload
		if (error instanceof TypeError && error.message.includes("fetch")) {
			return null;
		}
		throw error;
	}
}

/**
 * Confirm upload after uploading to signed URL
 */
async function confirmUpload(
	mediaId: string,
	metadata?: { width?: number; height?: number; size?: number },
	options?: MediaUploadOptions,
): Promise<MediaItem> {
	const response = await apiFetch(`${API_BASE}/media/${mediaId}/confirm`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(metadata || {}),
		signal: options?.signal,
	});
	const data = await parseApiResponse<{ item: MediaItem }>(
		response,
		i18n._(msg`Failed to confirm upload`),
	);
	return data.item;
}

/**
 * Upload directly to signed URL
 */
async function uploadToSignedUrl(
	file: File,
	uploadInfo: UploadUrlResponse,
	options?: MediaUploadOptions,
): Promise<void> {
	const response = await fetch(uploadInfo.uploadUrl, {
		method: uploadInfo.method,
		headers: {
			...uploadInfo.headers,
			"Content-Type": file.type,
		},
		body: file,
		signal: options?.signal,
	});

	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to upload file`));
}

/**
 * Get image dimensions from a file
 */
export async function getImageDimensions(
	file: File,
	options?: MediaUploadOptions,
): Promise<{ width: number; height: number } | null> {
	options?.signal?.throwIfAborted();
	if (!file.type.startsWith("image/")) {
		return null;
	}

	return new Promise((resolve, reject) => {
		const img = new Image();
		const objectUrl = URL.createObjectURL(file);
		const cleanup = () => {
			img.onload = null;
			img.onerror = null;
			options?.signal?.removeEventListener("abort", handleAbort);
			URL.revokeObjectURL(objectUrl);
		};
		const handleAbort = () => {
			cleanup();
			reject(options?.signal?.reason);
		};
		img.onload = () => {
			const dimensions = { width: img.naturalWidth, height: img.naturalHeight };
			cleanup();
			resolve(dimensions);
		};
		img.onerror = () => {
			cleanup();
			resolve(null);
		};
		options?.signal?.addEventListener("abort", handleAbort, { once: true });
		if (options?.signal?.aborted) {
			handleAbort();
			return;
		}
		img.src = objectUrl;
	});
}

/**
 * Upload media file via direct upload (legacy/local storage)
 */
async function uploadMediaDirect(file: File, opts?: UploadMediaOptions): Promise<MediaItem> {
	// Get image dimensions before upload
	const dimensions = await getImageDimensions(file, opts);

	const formData = new FormData();
	formData.append("file", file);
	// Send dimensions as form fields
	if (dimensions?.width) formData.append("width", String(dimensions.width));
	if (dimensions?.height) formData.append("height", String(dimensions.height));
	if (opts?.fieldId) formData.append("fieldId", opts.fieldId);
	if (opts?.deduplicate === false) formData.append("deduplicate", "false");
	if (opts?.ensureUniqueFilename) formData.append("ensureUniqueFilename", "true");
	if (opts?.folderId === null) formData.append("folderId", "unfiled");
	else if (opts?.folderId !== undefined) formData.append("folderId", opts.folderId);

	const response = await apiFetch(`${API_BASE}/media`, {
		method: "POST",
		body: formData,
		signal: opts?.signal,
	});
	const data = await parseApiResponse<{ item: MediaItem }>(
		response,
		i18n._(msg`Failed to upload media`),
	);
	return data.item;
}

/**
 * Upload media file
 *
 * Tries signed URL upload first (for S3/R2 storage), falls back to direct upload
 * (for local storage) if signed URLs are not supported.
 */
export async function uploadMedia(file: File, opts?: UploadMediaOptions): Promise<MediaItem> {
	opts?.signal?.throwIfAborted();
	// Try to get a signed upload URL
	const uploadInfo = await getUploadUrl(file, opts);

	if (!uploadInfo) {
		// Signed URLs not supported, use direct upload
		return uploadMediaDirect(file, opts);
	}
	if ("existing" in uploadInfo) {
		return fetchMediaItem(uploadInfo.mediaId, opts);
	}

	// Upload directly to storage via signed URL
	await uploadToSignedUrl(file, uploadInfo, opts);

	// Get image dimensions for confirmation
	const dimensions = await getImageDimensions(file, opts);

	// Confirm the upload
	return confirmUpload(
		uploadInfo.mediaId,
		{
			size: file.size,
			width: dimensions?.width,
			height: dimensions?.height,
		},
		opts,
	);
}

export async function replaceMediaImage(
	id: string,
	file: File,
	dimensions: { width: number; height: number },
	options?: MediaUploadOptions,
): Promise<LocalMediaItem> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("width", String(dimensions.width));
	formData.append("height", String(dimensions.height));
	const response = await apiFetch(`${API_BASE}/media/${encodeURIComponent(id)}/replace`, {
		method: "PUT",
		body: formData,
		signal: options?.signal,
	});
	const data = await parseApiResponse<{ item: LocalMediaItem }>(
		response,
		i18n._(msg`Failed to replace media image`),
	);
	return data.item;
}

/**
 * Delete media
 */
export async function deleteMedia(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/media/${id}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete media`));
}

/**
 * Update media metadata (dimensions, alt text, etc.)
 */
export interface MediaUpdateInput {
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
	folderId?: string | null;
	focalX?: number | null;
	focalY?: number | null;
}

export async function updateMedia(id: string, input: MediaUpdateInput): Promise<LocalMediaItem> {
	const response = await apiFetch(`${API_BASE}/media/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ item: LocalMediaItem }>(
		response,
		i18n._(msg`Failed to update media`),
	);
	return data.item;
}

// =============================================================================
// Media Providers API
// =============================================================================

/** Media provider capabilities */
export interface MediaProviderCapabilities {
	browse: boolean;
	search: boolean;
	upload: boolean;
	delete: boolean;
}

/** Media provider info from the API */
export interface MediaProviderInfo {
	id: string;
	name: string;
	icon?: string;
	capabilities: MediaProviderCapabilities;
}

/** Media item from a provider */
export interface MediaProviderItem {
	id: string;
	filename: string;
	mimeType: string;
	size?: number;
	width?: number;
	height?: number;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
	alt?: string;
	previewUrl?: string;
	meta?: Record<string, unknown>;
}

/**
 * Fetch all configured media providers
 */
export async function fetchMediaProviders(): Promise<MediaProviderInfo[]> {
	const response = await apiFetch(`${API_BASE}/media/providers`);
	const data = await parseApiResponse<{ items: MediaProviderInfo[] }>(
		response,
		i18n._(msg`Failed to fetch media providers`),
	);
	return data.items;
}

/**
 * Fetch media items from a specific provider
 */
export async function fetchProviderMedia(
	providerId: string,
	options?: {
		cursor?: string;
		limit?: number;
		query?: string;
		mimeType?: string | string[];
	},
): Promise<FindManyResult<MediaProviderItem>> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.query) params.set("query", options.query);
	if (options?.mimeType) {
		const value = Array.isArray(options.mimeType) ? options.mimeType.join(",") : options.mimeType;
		if (value) params.set("mimeType", value);
	}

	const url = `${API_BASE}/media/providers/${providerId}${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<MediaProviderItem>>(
		response,
		i18n._(msg`Failed to fetch provider media`),
	);
}

/**
 * Upload media to a specific provider
 */
export async function uploadToProvider(
	providerId: string,
	file: File,
	alt?: string,
	options?: MediaUploadOptions,
): Promise<MediaProviderItem> {
	options?.signal?.throwIfAborted();
	const formData = new FormData();
	formData.append("file", file);
	if (alt) formData.append("alt", alt);

	const response = await apiFetch(`${API_BASE}/media/providers/${providerId}`, {
		method: "POST",
		body: formData,
		signal: options?.signal,
	});
	const data = await parseApiResponse<{ item: MediaProviderItem }>(
		response,
		i18n._(msg`Failed to upload to provider`),
	);
	return data.item;
}

/**
 * Delete media from a specific provider
 */
export async function deleteFromProvider(providerId: string, itemId: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/media/providers/${providerId}/${itemId}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete from provider`));
}
