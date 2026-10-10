import type { MediaValue } from "emdash";

/**
 * An absolute URL for an image, for share images and other places that need
 * a plain URL. Images picked from the media library have no `src`.
 */
export function absoluteImageUrl(image: MediaValue, origin: string): string | undefined {
	if (image.src) return new URL(image.src, origin).href;
	// Only media in the site's own storage is served by the media file route.
	if ((image.provider ?? "local") !== "local") {
		return image.previewUrl ? new URL(image.previewUrl, origin).href : undefined;
	}
	const storageKey = typeof image.meta?.storageKey === "string" ? image.meta.storageKey : image.id;
	return `${origin}/_emdash/api/media/file/${storageKey}`;
}
