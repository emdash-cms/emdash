/**
 * Deterministic image-metadata extractor (plan W8.3 / Slice-B design
 * 2026-07-17). Turns the raw binary files carried on a validated plugin
 * bundle (`ValidatedBundleFile[]` — `{ path, bytes }`) into the
 * `ImageAnalysisImage[]` the vision adapter consumes: MIME sniffed from magic
 * bytes (never the filename extension), SHA-256 + base64 of the exact bytes,
 * pixel dimensions parsed from the format header, and an advisory
 * icon/screenshot classification.
 *
 * Pure and total: every parser bounds-checks each read and returns `null` on a
 * truncated or malformed header rather than throwing. An image the extractor
 * cannot process (unreadable dimensions, over-cap size/count) is reported as
 * `skipped`, degrading image coverage to `partial`; a crafted or corrupt file
 * never crashes the assessment run. Non-image files (code, unknown binaries)
 * are ignored entirely — they are not part of the image surface.
 *
 * Caps mirror the vision adapter's (`MAX_IMAGES`, `MAX_IMAGE_BYTES`,
 * `MAX_TOTAL_IMAGE_BYTES`), enforced here against the predicted base64 length
 * so an over-cap image is dropped BEFORE its base64 is materialised — the
 * adapter measures `dataBase64.length`, so predicting it keeps the two in step
 * and bounds this module's own memory use on a bundle stuffed with images.
 */

import type { ValidatedBundleFile } from "@emdash-cms/registry-verification";

import {
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	MAX_TOTAL_IMAGE_BYTES,
	type ImageAnalysisImage,
} from "./image-ai-adapter.js";

export interface ExtractedBundleImages {
	readonly images: readonly ImageAnalysisImage[];
	/** Paths of files that sniffed as a supported image but could not be turned
	 * into an analysable image (unreadable dimensions, or dropped to fit the
	 * count/size caps). Drives `partial` image coverage. */
	readonly skipped: readonly string[];
}

/** Whichever dimension is smaller for an icon; larger, or non-square, reads as
 * a screenshot. Advisory only — `kind` is context shown to the vision model,
 * never a security boundary — so a coarse rule is sufficient. */
const ICON_MAX_DIMENSION = 512;
const ICON_MIN_ASPECT = 0.8;
const ICON_MAX_ASPECT = 1.25;

/**
 * Extracts the analysable image set from a validated bundle's files, in tar
 * order. The optional `iconPath` names the bundle-relative path the manifest
 * declares as its icon, forcing that file's classification; absent (the plugin
 * manifest carries no icon field today), classification falls back to
 * dimensions/aspect.
 */
export async function extractBundleImages(
	files: readonly ValidatedBundleFile[],
	iconPath?: string,
): Promise<ExtractedBundleImages> {
	const images: ImageAnalysisImage[] = [];
	const skipped: string[] = [];
	let totalBase64 = 0;

	for (const file of files) {
		const mime = detectImageMime(file.bytes);
		if (mime === null) continue; // not an image — not part of the image surface

		// From here the file IS a supported image, so any reason it cannot be
		// analysed (unreadable header, over a cap) records it as skipped, degrading
		// coverage, rather than silently dropping it.
		const dims = parseImageDimensions(mime, file.bytes);
		if (!dims) {
			skipped.push(file.path);
			continue;
		}

		const base64Length = predictedBase64Length(file.bytes.length);
		if (
			base64Length > MAX_IMAGE_BYTES ||
			images.length >= MAX_IMAGES ||
			totalBase64 + base64Length > MAX_TOTAL_IMAGE_BYTES
		) {
			skipped.push(file.path);
			continue;
		}

		const sha256 = await sha256Hex(file.bytes);
		images.push({
			path: file.path,
			mime,
			sha256,
			dataBase64: toBase64(file.bytes),
			width: dims.width,
			height: dims.height,
			kind: classifyKind(file.path, dims, iconPath),
		});
		totalBase64 += base64Length;
	}

	return { images, skipped };
}

/** Supported raster format from leading magic bytes, or `null` for a non-image
 * file. Never trusts the filename extension. */
function detectImageMime(bytes: Uint8Array): string | null {
	if (isPng(bytes)) return "image/png";
	if (isJpeg(bytes)) return "image/jpeg";
	if (isGif(bytes)) return "image/gif";
	if (isWebp(bytes)) return "image/webp";
	return null;
}

/** Intrinsic dimensions for an already-sniffed format, or `null` when the
 * header is truncated/malformed — the caller records that as a skipped image. */
function parseImageDimensions(mime: string, bytes: Uint8Array): Dimensions | null {
	switch (mime) {
		case "image/png":
			return parsePngDimensions(bytes);
		case "image/jpeg":
			return parseJpegDimensions(bytes);
		case "image/gif":
			return parseGifDimensions(bytes);
		case "image/webp":
			return parseWebpDimensions(bytes);
		default:
			return null;
	}
}

interface Dimensions {
	readonly width: number;
	readonly height: number;
}

function isPng(b: Uint8Array): boolean {
	return (
		b.length >= 8 &&
		b[0] === 0x89 &&
		b[1] === 0x50 &&
		b[2] === 0x4e &&
		b[3] === 0x47 &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	);
}

function isJpeg(b: Uint8Array): boolean {
	return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isGif(b: Uint8Array): boolean {
	// "GIF87a" or "GIF89a".
	return (
		b.length >= 6 &&
		b[0] === 0x47 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x38 &&
		(b[4] === 0x37 || b[4] === 0x39) &&
		b[5] === 0x61
	);
}

function isWebp(b: Uint8Array): boolean {
	// "RIFF" .... "WEBP".
	return (
		b.length >= 12 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	);
}

/** PNG IHDR: 8-byte signature, 4-byte chunk length, 4-byte "IHDR" type, then
 * width and height as big-endian uint32 at offsets 16 and 20. */
function parsePngDimensions(b: Uint8Array): Dimensions | null {
	if (b.length < 24) return null;
	if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
	const width = readU32BE(b, 16);
	const height = readU32BE(b, 20);
	return validDimensions(width, height);
}

/** GIF logical screen descriptor: width and height as little-endian uint16 at
 * offsets 6 and 8. */
function parseGifDimensions(b: Uint8Array): Dimensions | null {
	if (b.length < 10) return null;
	return validDimensions(readU16LE(b, 6), readU16LE(b, 8));
}

/** JPEG: walk segment markers from offset 2 to the first Start-Of-Frame
 * (SOF0–SOF15, excluding the DHT/JPG/DAC markers C4/C8/CC), whose payload is
 * precision(1), height(2 BE), width(2 BE). */
function parseJpegDimensions(b: Uint8Array): Dimensions | null {
	let offset = 2;
	while (offset + 1 < b.length) {
		if (b[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		let marker = b[offset + 1]!;
		// Skip fill bytes (a run of 0xff) and standalone markers (RSTn, SOI, EOI,
		// TEM) that carry no length.
		while (marker === 0xff && offset + 1 < b.length) {
			offset += 1;
			marker = b[offset + 1]!;
		}
		offset += 2;
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01)
			continue;
		if (offset + 1 >= b.length) return null;
		const segmentLength = readU16BE(b, offset);
		if (segmentLength < 2) return null;
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			if (offset + 7 >= b.length) return null;
			const height = readU16BE(b, offset + 3);
			const width = readU16BE(b, offset + 5);
			return validDimensions(width, height);
		}
		offset += segmentLength;
	}
	return null;
}

/** WebP RIFF container: the fourCC at offset 12 selects the bitstream variant
 * (VP8 lossy, VP8L lossless, VP8X extended), each carrying dimensions at a
 * different offset and encoding. */
function parseWebpDimensions(b: Uint8Array): Dimensions | null {
	if (b.length < 16) return null;
	const fourCc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
	if (fourCc === "VP8 ") return parseWebpLossy(b);
	if (fourCc === "VP8L") return parseWebpLossless(b);
	if (fourCc === "VP8X") return parseWebpExtended(b);
	return null;
}

/** Simple (lossy) WebP: after the 0x9d012a start code, 14-bit width and height
 * (little-endian) at offsets 26 and 28. */
function parseWebpLossy(b: Uint8Array): Dimensions | null {
	if (b.length < 30) return null;
	const width = readU16LE(b, 26) & 0x3fff;
	const height = readU16LE(b, 28) & 0x3fff;
	return validDimensions(width, height);
}

/** Lossless WebP: a 0x2f signature byte at offset 20, then a 32-bit
 * little-endian field packing (width-1) in bits 0–13 and (height-1) in bits
 * 14–27. */
function parseWebpLossless(b: Uint8Array): Dimensions | null {
	if (b.length < 25 || b[20] !== 0x2f) return null;
	const bits = readU32LE(b, 21);
	const width = (bits & 0x3fff) + 1;
	const height = ((bits >> 14) & 0x3fff) + 1;
	return validDimensions(width, height);
}

/** Extended WebP: canvas (width-1) and (height-1) as 24-bit little-endian
 * values at offsets 24 and 27. */
function parseWebpExtended(b: Uint8Array): Dimensions | null {
	if (b.length < 30) return null;
	const width = readU24LE(b, 24) + 1;
	const height = readU24LE(b, 27) + 1;
	return validDimensions(width, height);
}

function classifyKind(path: string, dims: Dimensions, iconPath?: string): "icon" | "screenshot" {
	if (iconPath !== undefined && path === iconPath) return "icon";
	const maxDimension = Math.max(dims.width, dims.height);
	const aspect = dims.width / dims.height;
	const nearSquare = aspect >= ICON_MIN_ASPECT && aspect <= ICON_MAX_ASPECT;
	return maxDimension <= ICON_MAX_DIMENSION && nearSquare ? "icon" : "screenshot";
}

function validDimensions(width: number, height: number): Dimensions | null {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return { width, height };
}

function readU16BE(b: Uint8Array, o: number): number {
	return (b[o]! << 8) | b[o + 1]!;
}

function readU16LE(b: Uint8Array, o: number): number {
	return b[o]! | (b[o + 1]! << 8);
}

function readU24LE(b: Uint8Array, o: number): number {
	return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

function readU32BE(b: Uint8Array, o: number): number {
	return (b[o]! * 0x1000000 + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!) >>> 0;
}

function readU32LE(b: Uint8Array, o: number): number {
	return (b[o]! + (b[o + 1]! << 8) + (b[o + 2]! << 16) + b[o + 3]! * 0x1000000) >>> 0;
}

/** Base64 length of `n` raw bytes: 4 characters per 3-byte group, padded. */
function predictedBase64Length(n: number): number {
	return Math.ceil(n / 3) * 4;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Standard (padded) base64 of the raw bytes for the adapter's `data:` URL.
 * Chunked so `String.fromCharCode` never receives an image-sized argument
 * list, which would overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}
