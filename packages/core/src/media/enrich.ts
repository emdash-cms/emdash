/**
 * Image Metadata Enrichment
 *
 * Single seam that derives image dimensions and LQIP placeholders (blurhash,
 * dominant color) from raw image bytes. Every server-side media-creation path
 * routes through this so records are populated consistently. Pure-JS and
 * Workers-safe (image-size reads headers only; generatePlaceholder guards
 * decode size).
 */

import { normalizeMime } from "./mime.js";
import { generatePlaceholder, readDimensions } from "./placeholder.js";

export interface EnrichedImageMetadata {
	width?: number;
	height?: number;
	blurhash?: string;
	dominantColor?: string;
}

/**
 * Derive dimensions + LQIP placeholders from image bytes.
 *
 * - Non-image content types return `{}`.
 * - `knownDimensions` (e.g. browser `naturalWidth/Height`) win over `image-size`
 *   because the browser applies EXIF orientation; `image-size` reports raw header
 *   dimensions, which are swapped for 90°/270°-rotated JPEGs.
 * - `placeholder` lets a caller decode a smaller thumbnail for the blurhash to
 *   avoid OOM on large originals; dimensions still come from `bytes`.
 * - Placeholders are jpeg/png only (the generator's supported formats); other
 *   image types still get dimensions.
 */
export async function enrichImageMetadata(
	bytes: Uint8Array,
	contentType: string,
	opts?: {
		knownDimensions?: { width: number; height: number };
		placeholder?: { bytes: Uint8Array; contentType: string };
	},
): Promise<EnrichedImageMetadata> {
	const normalizedContentType = normalizeMime(contentType);
	if (!normalizedContentType.startsWith("image/")) return {};

	// Dimensions for the returned record come from the main bytes (or the
	// caller's knownDimensions). The header is read exactly once here and passed
	// into generatePlaceholder so it isn't re-read on the no-override path.
	const dims = opts?.knownDimensions ?? readDimensions(bytes) ?? undefined;

	// When a smaller thumbnail override is supplied, decode that for the blurhash
	// but let generatePlaceholder read the thumbnail's own dimensions for the OOM
	// guard (the override buffer is what actually gets decoded). On the common
	// no-override path pass the dims already read from this same buffer.
	const override = opts?.placeholder;
	const placeholder = await generatePlaceholder(
		override ? override.bytes : bytes,
		override ? normalizeMime(override.contentType) : normalizedContentType,
		override ? undefined : dims,
	);

	return {
		width: dims?.width,
		height: dims?.height,
		blurhash: placeholder?.blurhash,
		dominantColor: placeholder?.dominantColor,
	};
}
