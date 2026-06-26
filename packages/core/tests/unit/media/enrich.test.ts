import { describe, expect, it } from "vitest";

import { enrichImageMetadata } from "../../../src/media/enrich.js";
import { GIF_1x1, JPEG_4x4, PNG_4x4 } from "../../utils/image-fixtures.js";

describe("enrichImageMetadata", () => {
	it("returns dimensions, blurhash and dominantColor for a JPEG", async () => {
		const result = await enrichImageMetadata(JPEG_4x4, "image/jpeg");
		expect(result.width).toBe(4);
		expect(result.height).toBe(4);
		expect(result.blurhash).toBeTruthy();
		expect(result.dominantColor).toMatch(/^rgb\(/);
	});

	it("returns dimensions and a blurhash for a PNG", async () => {
		const result = await enrichImageMetadata(PNG_4x4, "image/png");
		expect(result.width).toBe(4);
		expect(result.height).toBe(4);
		expect(result.blurhash).toBeTruthy();
	});

	it("returns an empty object for non-image content types", async () => {
		const result = await enrichImageMetadata(new Uint8Array([1, 2, 3]), "application/pdf");
		expect(result).toEqual({});
	});

	it("prefers knownDimensions over header-derived dimensions (EXIF orientation safety)", async () => {
		const result = await enrichImageMetadata(JPEG_4x4, "image/jpeg", {
			knownDimensions: { width: 5, height: 9 },
		});
		expect(result.width).toBe(5);
		expect(result.height).toBe(9);
	});

	it("decodes the placeholder override while keeping dimensions from the main bytes", async () => {
		const result = await enrichImageMetadata(JPEG_4x4, "image/jpeg", {
			placeholder: { bytes: PNG_4x4, contentType: "image/png" },
		});
		expect(result.width).toBe(4); // from JPEG_4x4 header
		expect(result.blurhash).toBeTruthy(); // decoded from the PNG override
	});

	it("returns dimensions but no blurhash for a GIF (placeholder format unsupported)", async () => {
		const result = await enrichImageMetadata(GIF_1x1, "image/gif");
		expect(result.width).toBe(1);
		expect(result.height).toBe(1);
		expect(result.blurhash).toBeUndefined();
	});

	it("normalizes uppercase content types before placeholder generation (image/JPEG)", async () => {
		const result = await enrichImageMetadata(JPEG_4x4, "image/JPEG");
		expect(result.width).toBe(4);
		expect(result.height).toBe(4);
		expect(result.blurhash).toBeTruthy();
		expect(result.dominantColor).toMatch(/^rgb\(/);
	});

	it("normalizes parameter-suffixed content types (image/jpeg; charset=binary)", async () => {
		const result = await enrichImageMetadata(JPEG_4x4, "image/jpeg; charset=binary");
		expect(result.blurhash).toBeTruthy();
	});

	it("treats image/JPG as jpeg", async () => {
		const result = await enrichImageMetadata(JPEG_4x4, "image/JPG");
		expect(result.blurhash).toBeTruthy();
	});
});
