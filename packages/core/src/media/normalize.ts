/**
 * Media Value Normalization
 *
 * Normalizes media field values into a consistent shape regardless of
 * creation path (seed scripts, media picker, WP import, URL input).
 *
 * Called at content create/update time when a media provider is available,
 * filling in missing dimensions, storageKey, mimeType, and filename from
 * the provider's `get()` method.
 */

import type { MediaProvider, MediaProviderItem, MediaValue } from "./types.js";

export const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";
const URL_PATTERN = /^https?:\/\//;

/**
 * Normalize a media field value into a consistent MediaValue shape.
 *
 * - `null`/`undefined` → `null`
 * - Bare URL string → `{ provider: "external", id: "", src: url }`
 * - Bare internal media URL → resolved via local provider's `get()`
 * - Bare local media ID → resolved via local provider's `get()`
 * - Object with `provider` + `id` → enriched with missing fields from provider
 */
export async function normalizeMediaValue(
	value: unknown,
	getProvider: (id: string) => MediaProvider | undefined,
): Promise<MediaValue | null> {
	if (value == null) return null;

	// Bare string URL
	if (typeof value === "string") {
		return normalizeStringUrl(value, getProvider);
	}

	// Not an object — can't normalize
	if (!isRecord(value)) return null;

	// Must have at least an id to be a valid media value
	if (!("id" in value) && !("src" in value)) return null;

	const provider = (typeof value.provider === "string" ? value.provider : undefined) || "local";
	const id = typeof value.id === "string" ? value.id : "";

	// External URLs — return as-is, no server-side dimension detection
	if (provider === "external") {
		return recordToMediaValue(value);
	}

	// Build the base value from the input
	const result: MediaValue = { ...recordToMediaValue(value), provider };

	// For local media, strip `src` — it's derived at display time from storageKey
	if (provider === "local") {
		delete result.src;
	}

	// Determine if we need to call the provider
	const needsDimensions = result.width == null || result.height == null;
	const needsStorageKey = provider === "local" && !result.meta?.storageKey;
	const needsFileInfo = !result.mimeType || !result.filename;
	// LQIP placeholders are immutable facts of the bytes: if an image record is
	// missing them, the provider may have gained them since (e.g. content saved
	// before LQIP backfill ran, or the row's blurhash was populated later). Pull
	// them on every image lookup so the LQIP backfill in mergeProviderData runs.
	const needsLqip =
		(result.mimeType ?? "").startsWith("image/") &&
		(result.blurhash == null || result.dominantColor == null);
	const needsLookup = needsDimensions || needsStorageKey || needsFileInfo || needsLqip;

	if (!needsLookup || !id) return result;

	// Try to enrich from provider
	const mediaProvider = getProvider(provider);
	if (!mediaProvider?.get) return result;

	let providerItem: MediaProviderItem | null;
	try {
		providerItem = await mediaProvider.get(id);
	} catch {
		return result;
	}

	if (!providerItem) return result;

	return mergeProviderData(result, providerItem);
}

async function normalizeStringUrl(
	url: string,
	getProvider: (id: string) => MediaProvider | undefined,
): Promise<MediaValue | null> {
	// Internal media URL — try to resolve via local provider
	if (url.startsWith(INTERNAL_MEDIA_PREFIX)) {
		return resolveInternalUrl(url, getProvider);
	}

	// External HTTP(S) URL
	if (URL_PATTERN.test(url)) {
		return Promise.resolve({
			provider: "external",
			id: "",
			src: url,
		});
	}

	const localMedia = await resolveLocalId(url, getProvider);
	if (localMedia) return localMedia;

	// Unrecognized string — preserve legacy behavior and treat as external
	return {
		provider: "external",
		id: "",
		src: url,
	};
}

async function resolveInternalUrl(
	url: string,
	getProvider: (id: string) => MediaProvider | undefined,
): Promise<MediaValue> {
	const storageKey = url.slice(INTERNAL_MEDIA_PREFIX.length);
	const localProvider = getProvider("local");

	if (!localProvider?.get) {
		return { provider: "external", id: "", src: url };
	}

	let item: MediaProviderItem | null;
	try {
		item = await localProvider.get(storageKey);
	} catch {
		return { provider: "external", id: "", src: url };
	}

	if (!item) {
		return { provider: "external", id: "", src: url };
	}

	return {
		provider: "local",
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		width: item.width,
		height: item.height,
		blurhash: item.blurhash,
		dominantColor: item.dominantColor,
		alt: item.alt,
		meta: item.meta,
	};
}

async function resolveLocalId(
	id: string,
	getProvider: (id: string) => MediaProvider | undefined,
): Promise<MediaValue | null> {
	const localProvider = getProvider("local");

	if (!localProvider?.get) return null;

	let item: MediaProviderItem | null;
	try {
		item = await localProvider.get(id);
	} catch {
		return null;
	}

	if (!item) return null;

	return {
		provider: "local",
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		width: item.width,
		height: item.height,
		blurhash: item.blurhash,
		dominantColor: item.dominantColor,
		alt: item.alt,
		meta: item.meta,
	};
}

/**
 * Merge provider data into an existing MediaValue, preserving caller-supplied fields.
 * Caller `alt` takes priority over provider `alt` (per-usage, not per-image).
 */
function mergeProviderData(existing: MediaValue, item: MediaProviderItem): MediaValue {
	const result = { ...existing };

	// Fill missing dimensions
	if (result.width == null && item.width != null) result.width = item.width;
	if (result.height == null && item.height != null) result.height = item.height;

	// Fill missing LQIP placeholders (immutable facts of the bytes; caller wins)
	if (result.blurhash == null && item.blurhash != null) result.blurhash = item.blurhash;
	if (result.dominantColor == null && item.dominantColor != null) {
		result.dominantColor = item.dominantColor;
	}

	// Fill missing file info
	if (!result.filename && item.filename) result.filename = item.filename;
	if (!result.mimeType && item.mimeType) result.mimeType = item.mimeType;

	// Fill missing alt (provider alt is fallback, not override)
	if (!result.alt && item.alt) result.alt = item.alt;

	// Fill missing meta (merge, don't replace)
	if (item.meta) {
		result.meta = { ...item.meta, ...result.meta };
	}

	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract known MediaValue fields from a runtime-checked record.
 * Avoids unsafe `as MediaValue` cast by reading each property explicitly.
 */
function recordToMediaValue(obj: Record<string, unknown>): MediaValue {
	const result: MediaValue = {
		id: typeof obj.id === "string" ? obj.id : "",
	};
	if (typeof obj.provider === "string") result.provider = obj.provider;
	if (typeof obj.src === "string") result.src = obj.src;
	if (typeof obj.previewUrl === "string") result.previewUrl = obj.previewUrl;
	if (typeof obj.filename === "string") result.filename = obj.filename;
	if (typeof obj.mimeType === "string") result.mimeType = obj.mimeType;
	if (typeof obj.width === "number") result.width = obj.width;
	if (typeof obj.height === "number") result.height = obj.height;
	if (typeof obj.blurhash === "string") result.blurhash = obj.blurhash;
	if (typeof obj.dominantColor === "string") result.dominantColor = obj.dominantColor;
	if (typeof obj.alt === "string") result.alt = obj.alt;
	if (isRecord(obj.meta)) result.meta = obj.meta;
	return result;
}
