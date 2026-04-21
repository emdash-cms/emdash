/**
 * Media upload, list, delete, and provider APIs
 */

import {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type FindManyResult,
} from "./client.js";

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
	mimeType?: string;
}): Promise<FindManyResult<MediaItem>> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.mimeType) params.set("mimeType", options.mimeType);

	const url = `${API_BASE}/media${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<MediaItem>>(response, "Failed to fetch media");
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

/**
 * Try to get a signed upload URL
 * Returns null if signed URLs are not supported (e.g., local storage)
 */
async function getUploadUrl(file: File): Promise<UploadUrlResponse | null> {
	try {
		const response = await apiFetch(`${API_BASE}/media/upload-url`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				filename: file.name,
				contentType: file.type,
				size: file.size,
			}),
		});

		if (response.status === 501) {
			// Not implemented - storage doesn't support signed URLs
			return null;
		}

		return parseApiResponse<UploadUrlResponse>(response, "Failed to get upload URL");
	} catch (error) {
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
): Promise<MediaItem> {
	const response = await apiFetch(`${API_BASE}/media/${mediaId}/confirm`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(metadata || {}),
	});
	const data = await parseApiResponse<{ item: MediaItem }>(response, "Failed to confirm upload");
	return data.item;
}

/**
 * Upload directly to signed URL
 */
async function uploadToSignedUrl(file: File, uploadInfo: UploadUrlResponse): Promise<void> {
	const response = await fetch(uploadInfo.uploadUrl, {
		method: uploadInfo.method,
		headers: {
			...uploadInfo.headers,
			"Content-Type": file.type,
		},
		body: file,
	});

	if (!response.ok) await throwResponseError(response, "Failed to upload file");
}

/**
 * Get image dimensions from a file
 */
async function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
	if (!file.type.startsWith("image/")) {
		return null;
	}

	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
			URL.revokeObjectURL(img.src);
		};
		img.onerror = () => {
			resolve(null);
			URL.revokeObjectURL(img.src);
		};
		img.src = URL.createObjectURL(file);
	});
}

/**
 * Upload media file via direct upload (legacy/local storage)
 */
async function uploadMediaDirect(file: File): Promise<MediaItem> {
	// Get image dimensions before upload
	const dimensions = await getImageDimensions(file);

	const formData = new FormData();
	formData.append("file", file);
	// Send dimensions as form fields
	if (dimensions?.width) formData.append("width", String(dimensions.width));
	if (dimensions?.height) formData.append("height", String(dimensions.height));

	const response = await apiFetch(`${API_BASE}/media`, {
		method: "POST",
		body: formData,
	});
	const data = await parseApiResponse<{ item: MediaItem }>(response, "Failed to upload media");
	return data.item;
}

/**
 * Upload media file
 *
 * Tries signed URL upload first (for S3/R2 storage), falls back to direct upload
 * (for local storage) if signed URLs are not supported.
 */
export async function uploadMedia(file: File): Promise<MediaItem> {
	// Try to get a signed upload URL
	const uploadInfo = await getUploadUrl(file);

	if (!uploadInfo) {
		// Signed URLs not supported, use direct upload
		return uploadMediaDirect(file);
	}

	// Upload directly to storage via signed URL
	await uploadToSignedUrl(file, uploadInfo);

	// Get image dimensions for confirmation
	const dimensions = await getImageDimensions(file);

	// Confirm the upload
	return confirmUpload(uploadInfo.mediaId, {
		size: file.size,
		width: dimensions?.width,
		height: dimensions?.height,
	});
}

/**
 * Delete media
 */
export async function deleteMedia(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/media/${id}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete media");
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
	const data = await parseApiResponse<{ item: MediaItem }>(response, "Failed to update media");
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
		"Failed to fetch media providers",
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
		mimeType?: string;
	},
): Promise<FindManyResult<MediaProviderItem>> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.query) params.set("query", options.query);
	if (options?.mimeType) params.set("mimeType", options.mimeType);

	const url = `${API_BASE}/media/providers/${providerId}${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<MediaProviderItem>>(
		response,
		"Failed to fetch provider media",
	);
}

/**
 * Upload media to a specific provider
 */
export async function uploadToProvider(
	providerId: string,
	file: File,
	alt?: string,
): Promise<MediaProviderItem> {
	const formData = new FormData();
	formData.append("file", file);
	if (alt) formData.append("alt", alt);

	const response = await apiFetch(`${API_BASE}/media/providers/${providerId}`, {
		method: "POST",
		body: formData,
	});
	const data = await parseApiResponse<{ item: MediaProviderItem }>(
		response,
		"Failed to upload to provider",
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
	if (!response.ok) await throwResponseError(response, "Failed to delete from provider");
}
