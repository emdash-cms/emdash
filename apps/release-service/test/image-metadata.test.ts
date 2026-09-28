import { describe, expect, it } from "vitest";

import { readImageDimensions } from "../src/publishing/image-metadata.js";

function writeUint16LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint24LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeUint32LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
	bytes[offset + 3] = (value >>> 24) & 0xff;
}

function webpChunk(type: string, data: Uint8Array): Uint8Array {
	const paddedLength = data.byteLength + (data.byteLength % 2);
	const bytes = new Uint8Array(20 + paddedLength);
	bytes.set([0x52, 0x49, 0x46, 0x46], 0);
	writeUint32LittleEndian(bytes, 4, bytes.byteLength - 8);
	bytes.set([0x57, 0x45, 0x42, 0x50], 8);
	bytes.set(
		Array.from(type, (character) => character.charCodeAt(0)),
		12,
	);
	writeUint32LittleEndian(bytes, 16, data.byteLength);
	bytes.set(data, 20);
	return bytes;
}

function vp8(width: number, height: number): Uint8Array {
	const data = new Uint8Array(10);
	data.set([0x9d, 0x01, 0x2a], 3);
	writeUint16LittleEndian(data, 6, width);
	writeUint16LittleEndian(data, 8, height);
	return webpChunk("VP8 ", data);
}

function vp8l(width: number, height: number): Uint8Array {
	const data = new Uint8Array(5);
	data[0] = 0x2f;
	writeUint32LittleEndian(data, 1, (width - 1) | ((height - 1) << 14));
	return webpChunk("VP8L", data);
}

function vp8x(width: number, height: number): Uint8Array {
	const data = new Uint8Array(10);
	writeUint24LittleEndian(data, 4, width - 1);
	writeUint24LittleEndian(data, 7, height - 1);
	return webpChunk("VP8X", data);
}

describe("image metadata", () => {
	it.each([
		["VP8", vp8(640, 360), { width: 640, height: 360 }],
		["VP8L", vp8l(390, 844), { width: 390, height: 844 }],
		["VP8X", vp8x(1440, 900), { width: 1440, height: 900 }],
	] as const)("reads %s WebP dimensions", (_format, bytes, expected) => {
		expect(readImageDimensions(bytes, "image/webp")).toEqual(expected);
	});

	it("rejects a truncated WebP chunk", () => {
		const bytes = vp8x(1440, 900).subarray(0, 24);
		expect(readImageDimensions(bytes, "image/webp")).toBeNull();
	});
});
