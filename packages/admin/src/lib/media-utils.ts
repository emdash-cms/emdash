import type { MediaItem, MediaProviderItem } from "./api/media.js";

export function providerItemToMediaItem(
	providerId: string,
	item: MediaProviderItem,
): MediaItem & { provider: string; meta?: Record<string, unknown> } {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		url: item.previewUrl || "",
		size: item.size || 0,
		width: item.width,
		height: item.height,
		alt: item.alt,
		createdAt: new Date().toISOString(),
		provider: providerId,
		meta: item.meta,
	} as MediaItem & { provider: string; meta?: Record<string, unknown> };
}

/** Root-absolute path prefix for locally stored media served by EmDash. */
const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";

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
): string {
	if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") return originalUrl;
	if (!originalUrl.startsWith(INTERNAL_MEDIA_PREFIX)) return originalUrl;

	// Astro authorizes the media route by absolute origin (see the
	// `image.remotePatterns` entry the EmDash integration registers), so the
	// transform source must be an absolute same-origin URL. The admin is served
	// from the site origin, so `window.location.origin` is the right host.
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	if (!origin) return originalUrl;

	const params = new URLSearchParams({
		href: `${origin}${originalUrl}`,
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
