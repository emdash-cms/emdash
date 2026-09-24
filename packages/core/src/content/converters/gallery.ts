/**
 * Shared sanitization for gallery block images and image media, used by both
 * converters so the editor round-trip and the stored shape stay in lockstep.
 */

import { localMediaFileUrl } from "../../media/url.js";
import type { PortableTextGalleryImage } from "./types.js";

export interface ImageMedia {
	asset: PortableTextGalleryImage["asset"];
	alt?: string;
	width?: number;
	height?: number;
}

/**
 * Read an image's media reference, alt text, and dimensions. Accepts the
 * reference shape (`_ref`, `url`) and the MediaValue that seeded `$media`
 * stores instead (`id`, `src`, `meta.storageKey`, dimensions). The image's own
 * `alt`, `width`, and `height` take precedence over the asset's.
 */
export function resolveImageMedia(image: unknown): ImageMedia {
	const record: Record<string, unknown> = isRecord(image) ? image : {};
	const asset: Record<string, unknown> = isRecord(record.asset) ? record.asset : {};
	// The media id is not a storage key, so local files need `url`.
	const storageKey = isRecord(asset.meta) ? nonEmptyString(asset.meta.storageKey) : undefined;
	const url =
		nonEmptyString(asset.url) ??
		nonEmptyString(asset.src) ??
		(storageKey ? localMediaFileUrl(storageKey) : undefined);
	const provider = nonEmptyString(asset.provider);
	const alt = nonEmptyString(record.alt) ?? nonEmptyString(asset.alt);
	const width = typeof record.width === "number" ? record.width : asset.width;
	const height = typeof record.height === "number" ? record.height : asset.height;

	const media: ImageMedia = {
		asset: {
			_type: "reference",
			_ref: nonEmptyString(asset._ref) ?? nonEmptyString(asset.id) ?? "",
			...(url ? { url } : {}),
			...(provider ? { provider } : {}),
		},
	};
	if (alt) media.alt = alt;
	if (typeof width === "number") media.width = width;
	if (typeof height === "number") media.height = height;
	return media;
}

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
		if (!isRecord(record.asset)) continue;
		const { asset, alt, width, height } = resolveImageMedia(record);

		const image: PortableTextGalleryImage = {
			_type: "image",
			_key:
				typeof record._key === "string" && record._key
					? record._key
					: generateKey
						? generateKey()
						: "",
			asset,
		};
		if (alt) image.alt = alt;
		if (typeof record.caption === "string" && record.caption) image.caption = record.caption;
		if (width !== undefined) image.width = width;
		if (height !== undefined) image.height = height;
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
