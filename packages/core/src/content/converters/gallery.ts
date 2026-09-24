/**
 * Shared sanitization for gallery block images, used by both converters so
 * the editor round-trip and the stored shape stay in lockstep.
 */

import { localMediaFileUrl } from "../../media/url.js";
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
		// Seeded `$media` resolves to a MediaValue (`id`, `src`, `meta.storageKey`, dimensions)
		// instead of a reference. The media id is not a storage key, so local files need `url`.
		const storageKey = isRecord(assetRecord.meta)
			? nonEmptyString(assetRecord.meta.storageKey)
			: undefined;
		const url =
			nonEmptyString(assetRecord.url) ??
			nonEmptyString(assetRecord.src) ??
			(storageKey ? localMediaFileUrl(storageKey) : undefined);
		const alt = nonEmptyString(record.alt) ?? nonEmptyString(assetRecord.alt);
		const width = typeof record.width === "number" ? record.width : assetRecord.width;
		const height = typeof record.height === "number" ? record.height : assetRecord.height;

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
				_ref: nonEmptyString(assetRecord._ref) ?? nonEmptyString(assetRecord.id) ?? "",
				...(url ? { url } : {}),
				...(typeof assetRecord.provider === "string" && assetRecord.provider
					? { provider: assetRecord.provider }
					: {}),
			},
		};
		if (alt) image.alt = alt;
		if (typeof record.caption === "string" && record.caption) image.caption = record.caption;
		if (typeof width === "number") image.width = width;
		if (typeof height === "number") image.height = height;
		if (typeof record.focalX === "number") image.focalX = record.focalX;
		if (typeof record.focalY === "number") image.focalY = record.focalY;
		if (typeof record.blurhash === "string" && record.blurhash) image.blurhash = record.blurhash;
		if (typeof record.dominantColor === "string" && record.dominantColor)
			image.dominantColor = record.dominantColor;

		images.push(image);
	}

	return images;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
