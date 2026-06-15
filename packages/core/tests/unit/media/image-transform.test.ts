import { describe, it, expect } from "vitest";

import {
	ALLOWED_TRANSFORM_FORMATS,
	DEFAULT_TRANSFORM_FORMAT,
	MAX_TRANSFORM_WIDTH,
	TRANSFORM_MEDIA_PREFIX,
	buildTransformUrl,
	buildTransformSrcset,
	buildTransformedImage,
	isSafeTransformKey,
	isTransformFormat,
	parseTransformParams,
} from "../../../src/media/image-transform.js";
import { responsiveWidths } from "../../../src/media/responsive.js";

const KEY = "01ABCDEF.jpg";
const INTERNAL = `/_emdash/api/media/file/${KEY}`;

describe("buildTransformUrl", () => {
	it("builds a transform-route URL with width and default format", () => {
		expect(buildTransformUrl(KEY, { width: 480 })).toBe(
			`${TRANSFORM_MEDIA_PREFIX}${KEY}?w=480&f=${DEFAULT_TRANSFORM_FORMAT}`,
		);
	});

	it("includes height, format, and quality when provided", () => {
		expect(buildTransformUrl(KEY, { width: 480, height: 270, format: "avif", quality: 80 })).toBe(
			`${TRANSFORM_MEDIA_PREFIX}${KEY}?w=480&h=270&f=avif&q=80`,
		);
	});

	it("url-encodes the key", () => {
		expect(buildTransformUrl("a b.jpg", { width: 100 })).toContain("a%20b.jpg");
	});
});

describe("buildTransformSrcset", () => {
	it("emits a candidate per responsive width, preserving aspect ratio", () => {
		const srcset = buildTransformSrcset(KEY, { width: 400, height: 200 });
		const entries = srcset.split(", ");
		expect(entries).toHaveLength(responsiveWidths(400).length);
		// 2:1 aspect ratio is preserved: width 640 -> height 320
		expect(srcset).toContain(`${TRANSFORM_MEDIA_PREFIX}${KEY}?w=640&h=320&f=webp 640w`);
	});

	it("returns an empty string without a width", () => {
		expect(buildTransformSrcset(KEY, {})).toBe("");
	});
});

describe("buildTransformedImage", () => {
	it("returns a transform-route rendition for internal media when enabled", () => {
		const result = buildTransformedImage(true, INTERNAL, { width: 480, height: 270 });
		expect(result).not.toBeNull();
		expect(result?.src).toBe(`${TRANSFORM_MEDIA_PREFIX}${KEY}?w=480&h=270&f=webp`);
		expect(result?.srcset).toContain(" 480w");
		expect(result?.sizes).toBe("(min-width: 480px) 480px, 100vw");
	});

	it("returns null when no transformer is available", () => {
		expect(buildTransformedImage(false, INTERNAL, { width: 480, height: 270 })).toBeNull();
	});

	it("returns null when width is unknown", () => {
		expect(buildTransformedImage(true, INTERNAL, {})).toBeNull();
	});

	it("returns null for external/CDN URLs (handled by the astro:assets path)", () => {
		expect(
			buildTransformedImage(true, "https://cdn.example.com/01ABCDEF.jpg", {
				width: 480,
				height: 270,
			}),
		).toBeNull();
	});

	it("returns null for an internal URL whose key is unsafe", () => {
		expect(
			buildTransformedImage(true, "/_emdash/api/media/file/../secret", { width: 480 }),
		).toBeNull();
	});
});

describe("isSafeTransformKey", () => {
	it("accepts flat ulid-with-extension keys", () => {
		expect(isSafeTransformKey("01HXYZ.webp")).toBe(true);
		expect(isSafeTransformKey("a-b_c.JPG")).toBe(true);
	});

	it("rejects slashes, traversal, and query characters", () => {
		expect(isSafeTransformKey("a/b.jpg")).toBe(false);
		expect(isSafeTransformKey("../secret")).toBe(false);
		expect(isSafeTransformKey("a.jpg?x=1")).toBe(false);
		expect(isSafeTransformKey("")).toBe(false);
	});
});

describe("isTransformFormat", () => {
	it("accepts allowed formats and rejects others", () => {
		for (const f of ALLOWED_TRANSFORM_FORMATS) expect(isTransformFormat(f)).toBe(true);
		expect(isTransformFormat("gif")).toBe(false);
		expect(isTransformFormat("svg")).toBe(false);
	});
});

describe("parseTransformParams", () => {
	const parse = (qs: string) => parseTransformParams(new URLSearchParams(qs));

	it("parses width, height, format, and quality", () => {
		const result = parse("w=480&h=270&f=avif&q=75");
		expect(result).toEqual({
			ok: true,
			options: { width: 480, height: 270, format: "avif", quality: 75 },
		});
	});

	it("defaults the format when omitted", () => {
		const result = parse("w=480");
		expect(result.ok && result.options.format).toBe(DEFAULT_TRANSFORM_FORMAT);
	});

	it("requires width", () => {
		expect(parse("h=270").ok).toBe(false);
	});

	it("rejects a non-integer or out-of-range width", () => {
		expect(parse("w=abc").ok).toBe(false);
		expect(parse("w=0").ok).toBe(false);
		expect(parse(`w=${MAX_TRANSFORM_WIDTH + 1}`).ok).toBe(false);
	});

	it("rejects an unsupported format", () => {
		expect(parse("w=480&f=gif").ok).toBe(false);
	});

	it("rejects an out-of-range quality", () => {
		expect(parse("w=480&q=0").ok).toBe(false);
		expect(parse("w=480&q=101").ok).toBe(false);
	});
});
