/**
 * Shared sanitization for gallery block images, used by both converters so
 * the editor round-trip and the stored shape stay in lockstep.
 */

import type { PortableTextGalleryImage } from "./types.js";

/**
 * Normalize an untrusted `images` value into well-formed gallery images.
 * Non-object entries and entries without an asset object are dropped.
 * Missing `_key`s are filled via `generateKey` when provided (PM → PT);
 * left empty otherwise (PT → PM keeps whatever the block carried).
 */
export function sanitizeGalleryImages(
	value: unknown,
	generateKey?: () => string,
): PortableTextGalleryImage[] {
	if (!Array.isArray(value)) return [];

	const images: PortableTextGalleryImage[] = [];
	for (const entry of value as unknown[]) {
		if (!isRecord(entry)) continue;
		const record = entry;
		const asset = record.asset;
		if (!isRecord(asset)) continue;
		const assetRecord = asset;

		const image: PortableTextGalleryImage = {
			_type: "image",
			_key:
				typeof record._key === "string" && record._key
					? record._key
					: generateKey
						? generateKey()
						: "",
			asset: {
				_type: "reference",
				_ref: typeof assetRecord._ref === "string" ? assetRecord._ref : "",
				...(typeof assetRecord.url === "string" && assetRecord.url ? { url: assetRecord.url } : {}),
				...(typeof assetRecord.provider === "string" && assetRecord.provider
					? { provider: assetRecord.provider }
					: {}),
			},
		};
		if (typeof record.alt === "string" && record.alt) image.alt = record.alt;
		if (typeof record.caption === "string" && record.caption) image.caption = record.caption;
		if (typeof record.width === "number") image.width = record.width;
		if (typeof record.height === "number") image.height = record.height;
		if (typeof record.blurhash === "string" && record.blurhash) image.blurhash = record.blurhash;
		if (typeof record.dominantColor === "string" && record.dominantColor)
			image.dominantColor = record.dominantColor;

		images.push(image);
	}

	return images;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
