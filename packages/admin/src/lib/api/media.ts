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
}

/** Trim and clamp a search term to the server-accepted range. */
export function normalizeMediaSearch(value: string | undefined | null): string {
	return (value ?? "").trim().slice(0, MEDIA_SEARCH_MAX_LENGTH);
}

export interface MediaItem {
	id: string;
	filename: string;
	mimeType: string;
	url: string;
	/** Storage key for local media (e.g., "01ABC.jpg"). Not present for external URLs. */
	storageKey?: string;
	size: number;
	width?: number;
	height?: number;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
	alt?: string;
	caption?: string;
	createdAt: string;
	/** Provider ID for external media (e.g., "cloudflare-images") */
	provider?: string;
	/** Provider-specific metadata */
	meta?: Record<string, unknown>;
}

/**
 * Fetch media list
 */
export async function fetchMediaList(options?: {
	cursor?: string;
	limit?: number;
	mimeType?: string | string[];
	/** Case-insensitive filename substring search (also matches extensions). */
	search?: string;
}): Promise<FindManyResult<MediaItem>> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.mimeType) {
		const value = Array.isArray(options.mimeType) ? options.mimeType.join(",") : options.mimeType;
		if (value) params.set("mimeType", value);
	}
	if (options?.search) {
		// Trim and clamp to the server's accepted range so a long or
		// whitespace-only term can't trigger an avoidable 400.
		const q = normalizeMediaSearch(options.search);
		if (q) params.set("q", q);
	}

	const url = `${API_BASE}/media${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<MediaItem>>(response, i18n._(msg`Failed to fetch media`));
}

/**
 * Fetch a single media item by id.
 *
 * Used to resolve an id-only reference (e.g. a byline's `avatarMediaId`)
 * back into a full media item for display.
 */
export async function fetchMediaItem(id: string, options?: MediaUploadOptions): Promise<MediaItem> {
	const response = await apiFetch(`${API_BASE}/media/${id}`, { signal: options?.signal });
	const data = await parseApiResponse<{ item: MediaItem }>(
		response,
		i18n._(msg`Failed to fetch media item`),
	);
	return data.item;
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
		const contentHash = await computeContentHash(file, opts?.signal);
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
async function getImageDimensions(
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
export async function updateMedia(
	id: string,
	input: { alt?: string; caption?: string; width?: number; height?: number },
): Promise<MediaItem> {
	const response = await apiFetch(`${API_BASE}/media/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ item: MediaItem }>(
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
