import type { MediaItem, MediaProviderItem } from "./api/media.js";

export function canonicalMediaProviderId(provider: string | undefined): string {
	if (!provider) return "local";
	return provider === "external-url" ? "external" : provider;
}

export interface MediaFocalPoint {
	focalX: number;
	focalY: number;
}

function isFocalCoordinate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function normalizeMediaFocalPoint(value: {
	focalX?: number | null;
	focalY?: number | null;
}): MediaFocalPoint | null {
	const { focalX, focalY } = value;
	if (!isFocalCoordinate(focalX) || !isFocalCoordinate(focalY)) return null;
	return { focalX, focalY };
}

export function getMediaObjectPosition(value: {
	focalX?: number | null;
	focalY?: number | null;
}): string | undefined {
	const point = normalizeMediaFocalPoint(value);
	if (!point) return undefined;
	return `${Math.round(point.focalX * 10_000) / 100}% ${Math.round(point.focalY * 10_000) / 100}%`;
}

/** Read a string value from an untyped `meta` bag, or undefined. */
export function metaString(
	meta: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = meta?.[key];
	return typeof value === "string" ? value : undefined;
}

/** Read a finite number from an untyped `meta` bag, or undefined. */
export function metaNumber(
	meta: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = meta?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Streaming playback URLs a provider may expose for a video/audio item. */
export interface MediaPlayback {
	hls?: string;
	dash?: string;
}

/**
 * Read streaming playback URLs from an untyped `meta` bag.
 *
 * Streaming providers do not expose a single fetchable file URL — Cloudflare
 * Stream, for example, reports `meta.playback = { hls, dash }` and uses
 * `previewUrl` for the poster thumbnail. Returns undefined when the item has
 * no streaming sources (e.g. a plain uploaded MP4, which is playable directly).
 */
export function metaPlayback(meta: Record<string, unknown> | undefined): MediaPlayback | undefined {
	const raw = meta?.playback;
	if (!isRecord(raw)) return undefined;
	const hls = typeof raw.hls === "string" ? raw.hls : undefined;
	const dash = typeof raw.dash === "string" ? raw.dash : undefined;
	return hls || dash ? { hls, dash } : undefined;
}

export function providerItemToMediaItem(
	providerId: string,
	item: MediaProviderItem,
): MediaItem & { provider: string; meta?: Record<string, unknown> } {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		url: item.previewUrl || "",
		// Providers may report size as a first-class field or stash it in `meta`
		// (Cloudflare Stream uses `meta.size`); 0 means "unknown".
		size: item.size ?? metaNumber(item.meta, "size") ?? 0,
		width: item.width,
		height: item.height,
		// Prefer first-class fields; some providers stash LQIP in `meta`.
		blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
		dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
		alt: item.alt,
		createdAt: new Date().toISOString(),
		provider: providerId,
		meta: item.meta,
	};
}

/** Root-absolute path prefix for locally stored media served by EmDash. */
const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";

export function getMediaPreviewUrl(originalUrl: string, contentHash?: string | null): string {
	if (!contentHash || !originalUrl.startsWith(INTERNAL_MEDIA_PREFIX)) return originalUrl;
	const separator = originalUrl.includes("?") ? "&" : "?";
	return `${originalUrl}${separator}_emdash_media=${encodeURIComponent(contentHash)}`;
}

/**
 * Default rendered width (CSS px) for admin grid thumbnails, requested at ~2x
 * the largest grid cell (200px) so they stay crisp on HiDPI displays.
 */
export const MEDIA_THUMBNAIL_WIDTH = 400;

/**
 * Build a display URL for a media thumbnail in the admin grid/list views.
 *
 * Large libraries were slow to browse and search because every grid cell loaded
 * the full-size original through the media proxy (#1488). This routes
 * same-origin raster images through Astro's runtime image endpoint (`/_image`)
 * to request a small resized rendition instead.
 *
 * Where a runtime image service transforms — sharp on Node, or the Cloudflare
 * Images binding on Workers (the `@astrojs/cloudflare` v13 default) — the grid
 * gets a lightweight thumbnail. Where none does (a `passthrough` config, or
 * behind Cloudflare Access where the endpoint's same-origin source fetch is
 * blocked) `/_image` streams the original, so this never renders worse than
 * before. Callers should still fall back to the original on image `error` for
 * the rare case where the endpoint rejects the request (e.g. a site whose
 * configured origin differs from the admin's).
 *
 * Returns the URL unchanged for non-raster media (an icon renders instead),
 * SVGs (vector — nothing to downscale, and some services reject them), and
 * anything not served from the local media route (external/provider URLs are
 * already remote renditions, not same-origin originals).
 */
export function getMediaThumbnailUrl(
	originalUrl: string,
	mimeType: string,
	width: number = MEDIA_THUMBNAIL_WIDTH,
	contentHash?: string | null,
): string {
	const previewUrl = getMediaPreviewUrl(originalUrl, contentHash);
	if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") return previewUrl;
	if (!originalUrl.startsWith(INTERNAL_MEDIA_PREFIX)) return previewUrl;

	// Astro authorizes the media route by absolute origin (see the
	// `image.remotePatterns` entry the EmDash integration registers), so the
	// transform source must be an absolute same-origin URL. The admin is served
	// from the site origin, so `window.location.origin` is the right host.
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	if (!origin) return previewUrl;

	const params = new URLSearchParams({
		href: `${origin}${previewUrl}`,
		w: String(width),
		f: "webp",
	});
	return `/_image?${params.toString()}`;
}

/**
 * `onError` fallback for grid thumbnails: if a `/_image` rendition fails to
 * load (e.g. the endpoint rejects the request on a site whose configured origin
 * differs from the admin's), swap in the original URL once. Guarded with a data
 * attribute so a failing original can't trigger a reload loop.
 */
export function fallbackToOriginalThumbnail(
	img: { dataset: DOMStringMap; src: string },
	originalUrl: string,
): void {
	if (img.dataset.thumbFallback) return;
	img.dataset.thumbFallback = "1";
	img.src = originalUrl;
}

export function getFileIcon(mimeType: string): string {
	if (mimeType.startsWith("video/")) return "🎬";
	if (mimeType.startsWith("audio/")) return "🎵";
	if (mimeType.includes("pdf")) return "📄";
	if (mimeType.includes("document") || mimeType.includes("word")) return "📝";
	if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "📊";
	return "📁";
}

export function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
