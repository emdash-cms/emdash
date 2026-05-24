/**
 * Thumbnail sizing for client-side placeholder generation.
 *
 * When the browser generates a thumbnail to send to the server for blurhash
 * generation, the thumbnail dimensions must fit within a bounded box. Naively
 * fixing one dimension and deriving the other from the aspect ratio can
 * explode for extreme aspect ratios (e.g. a 100×840000 image would produce a
 * 64×537600 canvas), defeating the purpose of the thumbnail.
 */

/** Max dimension (px) for client-generated upload thumbnails. */
export const THUMBNAIL_MAX_DIMENSION = 64;

/**
 * Compute thumbnail dimensions that fit within a THUMBNAIL_MAX_DIMENSION box,
 * preserving aspect ratio. Both output dimensions are clamped to at least 1.
 * Never upscales (scale is capped at 1).
 */
export function computeThumbnailSize(
	width: number,
	height: number,
): { width: number; height: number } {
	if (width <= 0 || height <= 0) {
		return { width: 1, height: 1 };
	}
	const maxDim = Math.max(width, height);
	const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / maxDim);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}
