/**
 * Image Placeholder Generation
 *
 * Generates blurhash and dominant color from image buffers for LQIP support.
 * Decodes images via jpeg-js (pure JS) and upng-js (pure JS, uses pako for
 * deflate). No Node-specific dependencies — works in Workers and Node SSR.
 */

import { encode } from "blurhash";
import { imageSize } from "image-size";

export interface PlaceholderData {
	blurhash: string;
	dominantColor: string;
}

const SUPPORTED_TYPES: Record<string, "jpeg" | "png"> = {
	"image/jpeg": "jpeg",
	"image/jpg": "jpeg",
	"image/png": "png",
};

/** Max width for blurhash input. Encode is O(w*h*components), so downsample first. */
const MAX_ENCODE_WIDTH = 32;

/** Max decoded RGBA size (32 MB). Images exceeding this skip placeholder generation. */
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

interface DecodedImage {
	width: number;
	height: number;
	data: Uint8Array;
}

/**
 * Decode a JPEG buffer into raw RGBA pixel data.
 */
async function decodeJpeg(buffer: Uint8Array): Promise<DecodedImage> {
	const { decode } = await import("jpeg-js");
	const result = decode(buffer, { useTArray: true });
	return { width: result.width, height: result.height, data: result.data };
}

/**
 * Decode a PNG buffer into raw RGBA pixel data.
 * Uses upng-js (pure JS with pako deflate) — no Node zlib dependency.
 */
async function decodePng(buffer: Uint8Array): Promise<DecodedImage> {
	// @ts-expect-error -- upng-js has no type declarations
	const UPNG = (await import("upng-js")).default;
	const img = UPNG.decode(buffer.buffer);
	// toRGBA8 returns an array of frames; take the first frame
	const frames: ArrayBuffer[] = UPNG.toRGBA8(img);
	const rgba = new Uint8Array(frames[0]);
	return { width: img.width, height: img.height, data: rgba };
}

/**
 * Extract the dominant color from RGBA pixel data.
 * Simple average of all non-transparent pixels.
 */
function extractDominantColor(data: Uint8Array, width: number, height: number): string {
	let r = 0;
	let g = 0;
	let b = 0;
	let count = 0;

	const len = width * height * 4;
	for (let i = 0; i < len; i += 4) {
		const a = data[i + 3];
		if (a < 128) continue; // skip mostly-transparent pixels
		r += data[i];
		g += data[i + 1];
		b += data[i + 2];
		count++;
	}

	if (count === 0) return "rgb(0,0,0)";

	const avgR = Math.round(r / count);
	const avgG = Math.round(g / count);
	const avgB = Math.round(b / count);
	return `rgb(${avgR},${avgG},${avgB})`;
}

/**
 * Read image dimensions from headers without decoding pixel data.
 */
function getImageDimensions(buffer: Uint8Array): { width: number; height: number } | null {
	try {
		const result = imageSize(buffer);
		if (result.width != null && result.height != null) {
			return { width: result.width, height: result.height };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Generate blurhash and dominant color from an image buffer.
 * Returns null for non-image MIME types or on failure.
 *
 * @param dimensions - Optional pre-known dimensions. Used as a fallback when
 *   image-size cannot parse the buffer (e.g. truncated headers). When the
 *   decoded size (width * height * 4) exceeds MAX_DECODED_BYTES, placeholder
 *   generation is skipped to avoid OOM on memory-constrained runtimes.
 */
export async function generatePlaceholder(
	buffer: Uint8Array,
	mimeType: string,
	dimensions?: { width: number; height: number },
): Promise<PlaceholderData | null> {
	const format = SUPPORTED_TYPES[mimeType];
	if (!format) return null;

	try {
		// Safety net: skip decode if the image would exceed the memory budget
		const dims = getImageDimensions(buffer) ?? dimensions;
		if (dims && dims.width * dims.height * 4 > MAX_DECODED_BYTES) {
			return null;
		}

		const imageData = format === "jpeg" ? await decodeJpeg(buffer) : await decodePng(buffer);
		const { width, height, data } = imageData;

		if (width === 0 || height === 0) return null;

		// Downsample for blurhash encoding if needed
		let encodePixels: Uint8ClampedArray;
		let encodeWidth: number;
		let encodeHeight: number;

		if (width > MAX_ENCODE_WIDTH) {
			const scale = MAX_ENCODE_WIDTH / width;
			encodeWidth = MAX_ENCODE_WIDTH;
			encodeHeight = Math.max(1, Math.round(height * scale));
			encodePixels = downsample(data, width, height, encodeWidth, encodeHeight);
		} else {
			encodeWidth = width;
			encodeHeight = height;
			encodePixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
		}

		const blurhash = encode(encodePixels, encodeWidth, encodeHeight, 4, 3);
		const dominantColor = extractDominantColor(data, width, height);

		return { blurhash, dominantColor };
	} catch {
		return null;
	}
}

/**
 * Nearest-neighbor downsample of RGBA pixel data.
 */
function downsample(
	src: Uint8Array,
	srcW: number,
	srcH: number,
	dstW: number,
	dstH: number,
): Uint8ClampedArray {
	const dst = new Uint8ClampedArray(dstW * dstH * 4);

	for (let y = 0; y < dstH; y++) {
		const srcY = Math.floor((y * srcH) / dstH);
		for (let x = 0; x < dstW; x++) {
			const srcX = Math.floor((x * srcW) / dstW);
			const srcIdx = (srcY * srcW + srcX) * 4;
			const dstIdx = (y * dstW + x) * 4;
			dst[dstIdx] = src[srcIdx]!;
			dst[dstIdx + 1] = src[srcIdx + 1]!;
			dst[dstIdx + 2] = src[srcIdx + 2]!;
			dst[dstIdx + 3] = src[srcIdx + 3]!;
		}
	}

	return dst;
}
