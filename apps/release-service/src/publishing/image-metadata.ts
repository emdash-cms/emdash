export interface ImageDimensions {
	width: number;
	height: number;
}

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

function uint16BigEndian(bytes: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 2 > bytes.byteLength) return null;
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint16LittleEndian(bytes: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 2 > bytes.byteLength) return null;
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 4 > bytes.byteLength) return null;
	return (
		(bytes[offset] ?? 0) * 0x1000000 +
		(bytes[offset + 1] ?? 0) * 0x10000 +
		(bytes[offset + 2] ?? 0) * 0x100 +
		(bytes[offset + 3] ?? 0)
	);
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 3 > bytes.byteLength) return null;
	return (
		(bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 0x100 + (bytes[offset + 2] ?? 0) * 0x10000
	);
}

function uint32LittleEndian(bytes: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 4 > bytes.byteLength) return null;
	return (
		(bytes[offset] ?? 0) +
		(bytes[offset + 1] ?? 0) * 0x100 +
		(bytes[offset + 2] ?? 0) * 0x10000 +
		(bytes[offset + 3] ?? 0) * 0x1000000
	);
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
	return expected.every((value, index) => bytes[offset + index] === value);
}

function dimensions(width: number | null, height: number | null): ImageDimensions | null {
	return width !== null && height !== null && width > 0 && height > 0 ? { width, height } : null;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (
		bytes.byteLength < 33 ||
		!matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
		uint32BigEndian(bytes, 8) !== 13 ||
		!matches(bytes, 12, [0x49, 0x48, 0x44, 0x52])
	) {
		return null;
	}
	return dimensions(uint32BigEndian(bytes, 16), uint32BigEndian(bytes, 20));
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.byteLength < 4 || !matches(bytes, 0, [0xff, 0xd8])) return null;
	let offset = 2;
	while (offset < bytes.byteLength) {
		if (bytes[offset] !== 0xff) return null;
		while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
		const marker = bytes[offset];
		if (marker === undefined || marker === 0x00) return null;
		offset += 1;
		if (marker === 0xd9 || marker === 0xda) return null;
		if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		const segmentLength = uint16BigEndian(bytes, offset);
		if (segmentLength === null || segmentLength < 2) return null;
		const segmentEnd = offset + segmentLength;
		if (segmentEnd > bytes.byteLength) return null;
		if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
			if (segmentLength < 7) return null;
			return dimensions(uint16BigEndian(bytes, offset + 5), uint16BigEndian(bytes, offset + 3));
		}
		offset = segmentEnd;
	}
	return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (
		bytes.byteLength < 20 ||
		!matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) ||
		!matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])
	) {
		return null;
	}
	const riffSize = uint32LittleEndian(bytes, 4);
	if (riffSize === null || riffSize < 12 || riffSize > bytes.byteLength - 8) return null;
	const end = riffSize + 8;
	let offset = 12;
	while (offset + 8 <= end) {
		const chunkSize = uint32LittleEndian(bytes, offset + 4);
		if (chunkSize === null) return null;
		const dataOffset = offset + 8;
		const dataEnd = dataOffset + chunkSize;
		if (!Number.isSafeInteger(dataEnd) || dataEnd > end) return null;

		if (matches(bytes, offset, [0x56, 0x50, 0x38, 0x58])) {
			if (chunkSize < 10) return null;
			const width = uint24LittleEndian(bytes, dataOffset + 4);
			const height = uint24LittleEndian(bytes, dataOffset + 7);
			return dimensions(width === null ? null : width + 1, height === null ? null : height + 1);
		}
		if (matches(bytes, offset, [0x56, 0x50, 0x38, 0x4c])) {
			if (chunkSize < 5 || bytes[dataOffset] !== 0x2f) return null;
			const packed = uint32LittleEndian(bytes, dataOffset + 1);
			if (packed === null) return null;
			return dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
		}
		if (matches(bytes, offset, [0x56, 0x50, 0x38, 0x20])) {
			if (chunkSize < 10 || !matches(bytes, dataOffset + 3, [0x9d, 0x01, 0x2a])) return null;
			const width = uint16LittleEndian(bytes, dataOffset + 6);
			const height = uint16LittleEndian(bytes, dataOffset + 8);
			return dimensions(
				width === null ? null : width & 0x3fff,
				height === null ? null : height & 0x3fff,
			);
		}

		offset = dataEnd + (chunkSize % 2);
	}
	return null;
}

export function readImageDimensions(
	bytes: Uint8Array,
	mimeType: ImageMimeType,
): ImageDimensions | null {
	switch (mimeType) {
		case "image/png":
			return pngDimensions(bytes);
		case "image/jpeg":
			return jpegDimensions(bytes);
		case "image/webp":
			return webpDimensions(bytes);
	}
}
