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
 *   for the *stored record* because the browser applies EXIF orientation;
 *   `image-size` reports raw header dimensions, which are swapped for
 *   90°/270°-rotated JPEGs. They are NOT used for the decode OOM guard — see below.
 * - The placeholder OOM guard uses only header dimensions read from the bytes
 *   actually decoded. Caller-supplied `knownDimensions` are untrusted for the
 *   guard: a client could claim a tiny size for a huge image to bypass the cap.
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

	// Header dimensions are read once from the actual bytes. They feed the
	// placeholder OOM guard, which must never trust caller-supplied dimensions:
	// `knownDimensions` is decoupled from the buffer, so a client could claim a
	// tiny size for a huge image and slip past the decoded-size cap, making the
	// decoder allocate an unbounded RGBA buffer and OOM the runtime. Only dims
	// read from the buffer that actually gets decoded can bound the decode.
	const headerDims = readDimensions(bytes) ?? undefined;

	// Dimensions published on the record prefer the caller's knownDimensions
	// (e.g. browser naturalWidth/Height, which apply EXIF orientation) over the
	// raw header dims, which are swapped for 90°/270°-rotated JPEGs.
	const recordDims = opts?.knownDimensions ?? headerDims;

	// When a smaller thumbnail override is supplied, decode that for the blurhash
	// and let generatePlaceholder read the thumbnail's own header for the OOM
	// guard (the override buffer is what actually gets decoded). On the common
	// no-override path pass the header dims already read from this same buffer.
	const override = opts?.placeholder;
	const placeholder = await generatePlaceholder(
		override ? override.bytes : bytes,
		override ? normalizeMime(override.contentType) : normalizedContentType,
		override ? undefined : headerDims,
	);

	return {
		width: recordDims?.width,
		height: recordDims?.height,
		blurhash: placeholder?.blurhash,
		dominantColor: placeholder?.dominantColor,
	};
}
