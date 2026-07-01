import { describe, it, expect } from "vitest";

import {
	matchInternalMediaKey,
	isSafeTransformKey,
	parseTransformParams,
	isTransformFormat,
	originalMediaHeaders,
	MAX_TRANSFORM_DIMENSION,
} from "../../../src/media/image-endpoint.js";

describe("matchInternalMediaKey", () => {
	it("extracts the key from a relative internal media URL", () => {
		expect(matchInternalMediaKey("/_emdash/api/media/file/01J5ABC.webp")).toBe("01J5ABC.webp");
	});

	it("extracts the key from an absolute internal media URL (the component absolutizes)", () => {
		expect(matchInternalMediaKey("https://example.com/_emdash/api/media/file/01J5ABC.webp")).toBe(
			"01J5ABC.webp",
		);
		// Host-agnostic: the key is read from our own storage, href is never fetched.
		expect(matchInternalMediaKey("http://localhost:4444/_emdash/api/media/file/a-b_c.png")).toBe(
			"a-b_c.png",
		);
	});

	it("ignores any query string or fragment on the URL", () => {
		expect(matchInternalMediaKey("/_emdash/api/media/file/x.jpg?foo=1")).toBe("x.jpg");
		expect(matchInternalMediaKey("https://example.com/_emdash/api/media/file/x.jpg#f")).toBe(
			"x.jpg",
		);
	});

	it("returns null for non-internal URLs", () => {
		expect(matchInternalMediaKey("/_astro/bundled.abc.png")).toBeNull();
		expect(matchInternalMediaKey("https://cdn.example.com/x.jpg")).toBeNull();
		expect(matchInternalMediaKey("/images/foo.jpg")).toBeNull();
	});

	it("returns null for empty/missing href", () => {
		expect(matchInternalMediaKey(null)).toBeNull();
		expect(matchInternalMediaKey(undefined)).toBeNull();
		expect(matchInternalMediaKey("")).toBeNull();
		expect(matchInternalMediaKey("/_emdash/api/media/file/")).toBeNull();
	});

	it("rejects traversal and unsafe key characters", () => {
		// ".." collapses the path back out of the media prefix
		expect(matchInternalMediaKey("/_emdash/api/media/file/../secret")).toBeNull();
		// a slash in the key (sub-path) is not the flat storage-key shape
		expect(matchInternalMediaKey("/_emdash/api/media/file/a/b.jpg")).toBeNull();
		// percent-encoding is rejected by the safe-key charset
		expect(matchInternalMediaKey("/_emdash/api/media/file/x%2e%2e")).toBeNull();
	});
});

describe("isSafeTransformKey", () => {
	it("accepts flat ulid+ext keys", () => {
		expect(isSafeTransformKey("01J5ABC.webp")).toBe(true);
		expect(isSafeTransformKey("a-b_c.1.png")).toBe(true);
	});

	it("rejects slashes, query chars, and whitespace", () => {
		expect(isSafeTransformKey("a/b")).toBe(false);
		expect(isSafeTransformKey("../secret")).toBe(false);
		expect(isSafeTransformKey("x?y")).toBe(false);
		expect(isSafeTransformKey("x y")).toBe(false);
	});
});

describe("isTransformFormat", () => {
	it("accepts supported formats and rejects others", () => {
		expect(isTransformFormat("webp")).toBe(true);
		expect(isTransformFormat("avif")).toBe(true);
		expect(isTransformFormat("gif")).toBe(false);
		expect(isTransformFormat("svg")).toBe(false);
	});
});

describe("parseTransformParams", () => {
	const parse = (qs: string) => parseTransformParams(new URLSearchParams(qs));

	it("requires a width", () => {
		const r = parse("h=200");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/width/i);
	});

	it("parses width, height, format, quality", () => {
		const r = parse("w=640&h=480&f=avif&q=80");
		expect(r).toEqual({
			ok: true,
			options: { width: 640, height: 480, format: "avif", quality: 80 },
		});
	});

	it("defaults format to webp and leaves height/quality undefined", () => {
		const r = parse("w=800");
		expect(r).toEqual({ ok: true, options: { width: 800, format: "webp" } });
	});

	it("rejects out-of-range and non-integer dimensions", () => {
		expect(parse("w=0").ok).toBe(false);
		expect(parse(`w=${MAX_TRANSFORM_DIMENSION + 1}`).ok).toBe(false);
		expect(parse("w=12.5").ok).toBe(false);
		expect(parse("w=640&h=-1").ok).toBe(false);
	});

	it("rejects unsupported format and bad quality", () => {
		expect(parse("w=640&f=gif").ok).toBe(false);
		expect(parse("w=640&q=0").ok).toBe(false);
		expect(parse("w=640&q=101").ok).toBe(false);
		expect(parse("w=640&q=foo").ok).toBe(false);
	});

	it("rejects exotic numeric encodings for dimensions", () => {
		expect(parse("w=1e3").ok).toBe(false);
		expect(parse("w=0x10").ok).toBe(false);
		expect(parse("w=+5").ok).toBe(false);
		expect(parse("w= 5 ").ok).toBe(false);
	});
});

describe("originalMediaHeaders", () => {
	it("renders safe raster types inline with a sandbox CSP", () => {
		const h = originalMediaHeaders("image/png");
		expect(h["Content-Type"]).toBe("image/png");
		expect(h["Content-Disposition"]).toBe("inline");
		expect(h["X-Content-Type-Options"]).toBe("nosniff");
		expect(h["Content-Security-Policy"]).toContain("sandbox");
	});

	it("forces attachment + sandbox for SVG and other active types", () => {
		expect(originalMediaHeaders("image/svg+xml")["Content-Disposition"]).toBe("attachment");
		expect(originalMediaHeaders("application/pdf")["Content-Disposition"]).toBe("attachment");
		expect(originalMediaHeaders("image/svg+xml")["Content-Security-Policy"]).toContain("sandbox");
	});
});
