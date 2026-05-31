import { describe, expect, it } from "vitest";

import { ArtifactError, buildArtifactRecord, measureImage } from "../src/publish/artifacts.js";

/**
 * A 1x1 transparent PNG. `image-size` reads the IHDR chunk from the header,
 * so the full image isn't needed — but this is a real, decodable PNG.
 */
const PNG_1x1 = Uint8Array.from(
	Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bf0a8a0000000049454e44ae426082",
		"hex",
	),
);

/** A 3x5 GIF87a. The logical-screen descriptor at bytes 6-9 carries the size. */
const GIF_3x5 = Uint8Array.from(Buffer.from("4749463837610300050080000000000000ffffff", "hex"));

/**
 * A minimal ISOBMFF/AVIF header (`ftyp` brand `avif` + `meta>iprp>ipco>ispe`).
 * `image-size` reads the brand as the type and the `ispe` box as the
 * dimensions (64x48); no full image data is needed.
 */
function box(name: string, payload: Buffer): Buffer {
	const buf = Buffer.alloc(8 + payload.length);
	buf.writeUInt32BE(buf.length, 0);
	buf.write(name, 4, "ascii");
	payload.copy(buf, 8);
	return buf;
}
const AVIF_64x48 = (() => {
	const ftyp = box(
		"ftyp",
		Buffer.concat([
			Buffer.from("avif", "ascii"),
			Buffer.from([0, 0, 0, 0]),
			Buffer.from("avifmif1", "ascii"),
		]),
	);
	const ispePayload = Buffer.alloc(12);
	ispePayload.writeUInt32BE(64, 4);
	ispePayload.writeUInt32BE(48, 8);
	const ispe = box("ispe", ispePayload);
	const meta = box(
		"meta",
		Buffer.concat([Buffer.from([0, 0, 0, 0]), box("iprp", box("ipco", ispe))]),
	);
	return new Uint8Array(Buffer.concat([ftyp, meta]));
})();

/** A minimal SVG with explicit width/height attributes — no longer an accepted type. */
const SVG_12x8 = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"></svg>',
);

describe("measureImage", () => {
	it("reads PNG dimensions and content type from header bytes", () => {
		expect(measureImage(PNG_1x1)).toEqual({
			contentType: "image/png",
			width: 1,
			height: 1,
		});
	});

	it("reads GIF dimensions and content type", () => {
		expect(measureImage(GIF_3x5)).toEqual({
			contentType: "image/gif",
			width: 3,
			height: 5,
		});
	});

	it("reads AVIF dimensions and maps to image/avif", () => {
		expect(measureImage(AVIF_64x48)).toEqual({
			contentType: "image/avif",
			width: 64,
			height: 48,
		});
	});

	it("rejects SVG (removed from the allowlist)", () => {
		try {
			measureImage(SVG_12x8);
			throw new Error("expected measureImage to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ArtifactError);
			expect((error as ArtifactError).code).toBe("ARTIFACT_UNSUPPORTED");
		}
	});

	it("rejects bytes that are not a recognised image", () => {
		const garbage = new TextEncoder().encode("this is not an image");
		expect(() => measureImage(garbage)).toThrow(ArtifactError);
	});

	it("rejects an image whose format isn't in the allowlist", () => {
		// A BMP header — image-size recognises it, but it's not an allowed type.
		const bmp = Uint8Array.from(
			Buffer.from("424d3a0000000000000036000000280000000100000001000000", "hex"),
		);
		try {
			measureImage(bmp);
			throw new Error("expected measureImage to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ArtifactError);
			expect((error as ArtifactError).code).toBe("ARTIFACT_UNSUPPORTED");
		}
	});
});

describe("buildArtifactRecord", () => {
	it("writes url, checksum, contentType, and dimensions", () => {
		const record = buildArtifactRecord({
			bytes: PNG_1x1,
			url: "https://cdn.example.com/gallery/1.0.0/icon.png",
		});
		expect(record).toMatchObject({
			url: "https://cdn.example.com/gallery/1.0.0/icon.png",
			contentType: "image/png",
			width: 1,
			height: 1,
		});
		// Multibase-multihash sha2-256: base32 prefix `b`, 56 chars total.
		expect(record.checksum).toMatch(/^b[a-z2-7]+$/);
		expect(record.checksum).toHaveLength(56);
	});

	it("carries lang through when set", () => {
		const record = buildArtifactRecord({
			bytes: PNG_1x1,
			url: "https://cdn.example.com/gallery/1.0.0/icon-fr.png",
			lang: "fr",
		});
		expect(record.lang).toBe("fr");
	});

	it("omits lang when not set", () => {
		const record = buildArtifactRecord({
			bytes: PNG_1x1,
			url: "https://cdn.example.com/gallery/1.0.0/icon.png",
		});
		expect(record).not.toHaveProperty("lang");
	});

	it("derives the same checksum the consumer would compute over the bytes", () => {
		const a = buildArtifactRecord({ bytes: PNG_1x1, url: "https://x/a.png" });
		const b = buildArtifactRecord({ bytes: PNG_1x1, url: "https://x/b.png" });
		expect(a.checksum).toBe(b.checksum);
	});
});
