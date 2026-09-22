import { describe, it, expect } from "vitest";

import {
	getMediaThumbnailUrl,
	fallbackToOriginalThumbnail,
	MEDIA_THUMBNAIL_WIDTH,
} from "../../src/lib/media-utils";

const LOCAL_IMAGE = "/_emdash/api/media/file/01ABC.jpg";

describe("getMediaThumbnailUrl", () => {
	it("preserves imported image URLs when their storage key cannot be transformed", () => {
		const original = "https://media.example.com/content/images/2024/photo.png";
		expect(
			getMediaThumbnailUrl(
				original,
				"image/png",
				400,
				"sha256:new",
				"content/images/2024/photo.png",
			),
		).toBe(original);
	});
	it("transforms storage-backed public HEIC URLs and preserves replacement versions", () => {
		const result = getMediaThumbnailUrl(
			"https://media.example.com/photo.heic",
			"image/heic",
			400,
			"sha256:new",
			"photo.heic",
		);
		const thumbnail = new URL(result, window.location.origin);
		expect(thumbnail.pathname).toBe("/_image");
		const source = new URL(thumbnail.searchParams.get("href")!);
		expect(source.pathname).toBe("/_emdash/api/media/file/photo.heic");
		expect(source.searchParams.get("_emdash_media")).toBe("sha256:new");
	});
	it("routes a local raster image through Astro's /_image endpoint", () => {
		const result = getMediaThumbnailUrl(LOCAL_IMAGE, "image/jpeg");
		expect(result.startsWith("/_image?")).toBe(true);

		const url = new URL(result, window.location.origin);
		expect(url.pathname).toBe("/_image");
		expect(url.searchParams.get("href")).toBe(`${window.location.origin}${LOCAL_IMAGE}`);
		expect(url.searchParams.get("w")).toBe(String(MEDIA_THUMBNAIL_WIDTH));
		expect(url.searchParams.get("f")).toBe("webp");
	});

	it("honors a custom width", () => {
		const result = getMediaThumbnailUrl(LOCAL_IMAGE, "image/png", 80);
		const url = new URL(result, window.location.origin);
		expect(url.searchParams.get("w")).toBe("80");
	});

	it("changes the thumbnail URL when stored image bytes change", () => {
		const before = getMediaThumbnailUrl(LOCAL_IMAGE, "image/jpeg", 400, "sha256:before");
		const after = getMediaThumbnailUrl(LOCAL_IMAGE, "image/jpeg", 400, "sha256:after");

		expect(after).not.toBe(before);
		const href = new URL(after, window.location.origin).searchParams.get("href");
		expect(new URL(href!).searchParams.get("_emdash_media")).toBe("sha256:after");
	});

	it("passes SVGs through unchanged (vector, nothing to downscale)", () => {
		const svg = "/_emdash/api/media/file/01ABC.svg";
		expect(getMediaThumbnailUrl(svg, "image/svg+xml")).toBe(svg);
	});

	it("passes non-image media through unchanged (an icon renders instead)", () => {
		const pdf = "/_emdash/api/media/file/01ABC.pdf";
		expect(getMediaThumbnailUrl(pdf, "application/pdf")).toBe(pdf);
	});

	it("passes external/provider URLs through unchanged (already a remote rendition)", () => {
		const external = "https://images.example.com/photo.jpg";
		expect(getMediaThumbnailUrl(external, "image/jpeg")).toBe(external);
	});
});

describe("fallbackToOriginalThumbnail", () => {
	it("swaps in the original URL on first error", () => {
		const img = { dataset: {} as DOMStringMap, src: "/_image?href=...&w=400&f=webp" };
		fallbackToOriginalThumbnail(img, LOCAL_IMAGE);
		expect(img.src).toBe(LOCAL_IMAGE);
		expect(img.dataset.thumbFallback).toBe("1");
	});

	it("does not loop if the original also fails", () => {
		const img = { dataset: { thumbFallback: "1" } as DOMStringMap, src: LOCAL_IMAGE };
		fallbackToOriginalThumbnail(img, "/some/other/url.jpg");
		// Guard short-circuits: src is left untouched.
		expect(img.src).toBe(LOCAL_IMAGE);
	});
});
