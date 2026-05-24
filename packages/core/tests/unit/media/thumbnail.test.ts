import { describe, expect, it } from "vitest";

import { THUMBNAIL_MAX_DIMENSION, computeThumbnailSize } from "../../../src/media/thumbnail.js";

describe("computeThumbnailSize", () => {
	it("scales a square image to the max dimension", () => {
		expect(computeThumbnailSize(5000, 5000)).toEqual({
			width: THUMBNAIL_MAX_DIMENSION,
			height: THUMBNAIL_MAX_DIMENSION,
		});
	});

	it("scales a wide image to fit within the bounding box", () => {
		const result = computeThumbnailSize(4000, 2000);
		expect(result.width).toBe(THUMBNAIL_MAX_DIMENSION);
		expect(result.height).toBe(THUMBNAIL_MAX_DIMENSION / 2);
	});

	it("scales a tall image to fit within the bounding box", () => {
		const result = computeThumbnailSize(2000, 4000);
		expect(result.width).toBe(THUMBNAIL_MAX_DIMENSION / 2);
		expect(result.height).toBe(THUMBNAIL_MAX_DIMENSION);
	});

	it("clamps extreme tall aspect ratios to the bounding box", () => {
		// Without clamping, naive code would produce a 64×537600 canvas.
		const result = computeThumbnailSize(100, 840_000);
		expect(result.width).toBeLessThanOrEqual(THUMBNAIL_MAX_DIMENSION);
		expect(result.height).toBeLessThanOrEqual(THUMBNAIL_MAX_DIMENSION);
		expect(result.width).toBeGreaterThanOrEqual(1);
		expect(result.height).toBe(THUMBNAIL_MAX_DIMENSION);
	});

	it("clamps extreme wide aspect ratios to the bounding box", () => {
		const result = computeThumbnailSize(840_000, 100);
		expect(result.width).toBe(THUMBNAIL_MAX_DIMENSION);
		expect(result.height).toBeGreaterThanOrEqual(1);
		expect(result.height).toBeLessThanOrEqual(THUMBNAIL_MAX_DIMENSION);
	});

	it("never upscales smaller images", () => {
		expect(computeThumbnailSize(10, 20)).toEqual({ width: 10, height: 20 });
		expect(computeThumbnailSize(1, 1)).toEqual({ width: 1, height: 1 });
	});

	it("returns a 1x1 fallback for zero or negative dimensions", () => {
		expect(computeThumbnailSize(0, 100)).toEqual({ width: 1, height: 1 });
		expect(computeThumbnailSize(100, 0)).toEqual({ width: 1, height: 1 });
		expect(computeThumbnailSize(-5, 10)).toEqual({ width: 1, height: 1 });
	});

	it("rounds fractional dimensions", () => {
		const result = computeThumbnailSize(300, 199);
		expect(Number.isInteger(result.width)).toBe(true);
		expect(Number.isInteger(result.height)).toBe(true);
	});
});
