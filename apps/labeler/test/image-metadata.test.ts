/**
 * Deterministic image-metadata extractor. Crafted format headers exercise each
 * parser; truncated/renamed/oversized inputs prove it never throws and only
 * degrades coverage.
 */

import type { ValidatedBundleFile } from "@emdash-cms/registry-verification";
import { describe, expect, it } from "vitest";

import { extractBundleImages } from "../src/image-metadata.js";

const encoder = new TextEncoder();

function bundleFile(path: string, bytes: Uint8Array): ValidatedBundleFile {
	return { path, bytes };
}

function png(width: number, height: number, extra = 0): Uint8Array {
	const bytes = new Uint8Array(24 + extra);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

function gif(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(10);
	bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
	const view = new DataView(bytes.buffer);
	view.setUint16(6, width, true);
	view.setUint16(8, height, true);
	return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(12);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
	const view = new DataView(bytes.buffer);
	view.setUint16(7, height);
	view.setUint16(9, width);
	return bytes;
}

function webpHeader(fourCc: string, length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
	bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
	bytes.set(encoder.encode(fourCc), 12);
	return bytes;
}

function webpLossy(width: number, height: number): Uint8Array {
	const bytes = webpHeader("VP8 ", 30);
	const view = new DataView(bytes.buffer);
	view.setUint16(26, width & 0x3fff, true);
	view.setUint16(28, height & 0x3fff, true);
	return bytes;
}

function webpLossless(width: number, height: number): Uint8Array {
	const bytes = webpHeader("VP8L", 25);
	bytes[20] = 0x2f;
	const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
	new DataView(bytes.buffer).setUint32(21, bits >>> 0, true);
	return bytes;
}

function webpExtended(width: number, height: number): Uint8Array {
	const bytes = webpHeader("VP8X", 30);
	const w = width - 1;
	const h = height - 1;
	bytes[24] = w & 0xff;
	bytes[25] = (w >> 8) & 0xff;
	bytes[26] = (w >> 16) & 0xff;
	bytes[27] = h & 0xff;
	bytes[28] = (h >> 8) & 0xff;
	bytes[29] = (h >> 16) & 0xff;
	return bytes;
}

describe("extractBundleImages: format parsing", () => {
	it("parses PNG dimensions and mime from the IHDR header", async () => {
		const { images, skipped } = await extractBundleImages([bundleFile("a.png", png(640, 480))]);
		expect(skipped).toEqual([]);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ mime: "image/png", width: 640, height: 480 });
	});

	it("parses JPEG dimensions from the SOF marker", async () => {
		const { images } = await extractBundleImages([bundleFile("a.jpg", jpeg(800, 600))]);
		expect(images[0]).toMatchObject({ mime: "image/jpeg", width: 800, height: 600 });
	});

	it("parses GIF dimensions from the logical screen descriptor", async () => {
		const { images } = await extractBundleImages([bundleFile("a.gif", gif(120, 90))]);
		expect(images[0]).toMatchObject({ mime: "image/gif", width: 120, height: 90 });
	});

	it("parses all three WebP bitstream variants", async () => {
		const files = [
			bundleFile("lossy.webp", webpLossy(200, 100)),
			bundleFile("lossless.webp", webpLossless(300, 150)),
			bundleFile("extended.webp", webpExtended(1024, 768)),
		];
		const { images } = await extractBundleImages(files);
		expect(images.map((i) => [i.mime, i.width, i.height])).toEqual([
			["image/webp", 200, 100],
			["image/webp", 300, 150],
			["image/webp", 1024, 768],
		]);
	});
});

describe("extractBundleImages: magic-byte sniffing", () => {
	it("sniffs mime from bytes, not the filename extension", async () => {
		const { images } = await extractBundleImages([bundleFile("actually-a-png.txt", png(16, 16))]);
		expect(images[0]?.mime).toBe("image/png");
	});

	it("does not treat a text file with an image extension as an image", async () => {
		const source = encoder.encode("export default function () {}\n");
		const { images, skipped } = await extractBundleImages([bundleFile("evil.png", source)]);
		expect(images).toEqual([]);
		expect(skipped).toEqual([]);
	});

	it("ignores non-image files entirely — not counted as images or skips", async () => {
		const { images, skipped } = await extractBundleImages([
			bundleFile("manifest.json", encoder.encode("{}")),
			bundleFile("icon.png", png(32, 32)),
		]);
		expect(images).toHaveLength(1);
		expect(skipped).toEqual([]);
	});
});

describe("extractBundleImages: malformed input never throws", () => {
	it("skips a truncated PNG whose IHDR is incomplete", async () => {
		const truncated = png(64, 64).subarray(0, 18);
		const { images, skipped } = await extractBundleImages([bundleFile("broken.png", truncated)]);
		expect(images).toEqual([]);
		expect(skipped).toEqual(["broken.png"]);
	});

	it("skips a JPEG with no SOF marker", async () => {
		const headerOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
		const { images, skipped } = await extractBundleImages([bundleFile("empty.jpg", headerOnly)]);
		expect(images).toEqual([]);
		expect(skipped).toEqual(["empty.jpg"]);
	});

	it("skips a zero-dimension image rather than emitting it", async () => {
		const { images, skipped } = await extractBundleImages([bundleFile("zero.gif", gif(0, 0))]);
		expect(images).toEqual([]);
		expect(skipped).toEqual(["zero.gif"]);
	});
});

describe("extractBundleImages: caps degrade coverage to partial", () => {
	it("skips an image over the per-image byte cap", async () => {
		const big = png(64, 64, 1_600_000);
		const { images, skipped } = await extractBundleImages([bundleFile("huge.png", big)]);
		expect(images).toEqual([]);
		expect(skipped).toEqual(["huge.png"]);
	});

	it("keeps at most MAX_IMAGES and skips the overflow", async () => {
		const files = Array.from({ length: 13 }, (_, i) => bundleFile(`icon-${i}.png`, png(16, 16)));
		const { images, skipped } = await extractBundleImages(files);
		expect(images).toHaveLength(12);
		expect(skipped).toEqual(["icon-12.png"]);
	});

	it("skips images that would exceed the aggregate byte cap", async () => {
		// Each image is exactly 1.2 MB raw → 1.6 MB base64; five reach the 8 MB
		// aggregate cap exactly, the sixth overflows and is skipped.
		const files = Array.from({ length: 6 }, (_, i) =>
			bundleFile(`shot-${i}.png`, png(64, 64, 1_200_000 - 24)),
		);
		const { images, skipped } = await extractBundleImages(files);
		expect(images).toHaveLength(5);
		expect(skipped).toEqual(["shot-5.png"]);
	});
});

describe("extractBundleImages: classification and hashing", () => {
	it("classifies a small near-square image as an icon and a large one as a screenshot", async () => {
		const { images } = await extractBundleImages([
			bundleFile("icon.png", png(128, 128)),
			bundleFile("shot.png", png(1280, 720)),
		]);
		expect(images.find((i) => i.path === "icon.png")?.kind).toBe("icon");
		expect(images.find((i) => i.path === "shot.png")?.kind).toBe("screenshot");
	});

	it("honours a declared manifest icon path over the dimension heuristic", async () => {
		const { images } = await extractBundleImages(
			[bundleFile("assets/brand.png", png(1280, 720))],
			"assets/brand.png",
		);
		expect(images[0]?.kind).toBe("icon");
	});

	it("emits the SHA-256 hex and base64 of the exact bytes", async () => {
		const bytes = png(16, 16);
		const { images } = await extractBundleImages([bundleFile("a.png", bytes)]);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const expectedHex = Array.from(new Uint8Array(digest), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		expect(images[0]?.sha256).toBe(expectedHex);
		const decoded = Uint8Array.from(atob(images[0]!.dataBase64), (c) => c.charCodeAt(0));
		expect(decoded).toEqual(bytes);
	});
});
