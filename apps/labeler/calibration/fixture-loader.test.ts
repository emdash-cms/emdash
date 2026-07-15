import { describe, expect, it } from "vitest";

import {
	buildCodeAnalysisInput,
	buildImageAnalysisImage,
	parsePngDimensions,
	sha256Hex,
	toBase64,
	type FixtureManifest,
} from "./fixture-loader.js";

function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

describe("parsePngDimensions", () => {
	it("reads width and height from the IHDR header", () => {
		expect(parsePngDimensions(pngHeader(512, 512))).toEqual({ width: 512, height: 512 });
		expect(parsePngDimensions(pngHeader(3840, 2304))).toEqual({ width: 3840, height: 2304 });
	});

	it("rejects a non-PNG signature", () => {
		const bytes = pngHeader(1, 1);
		bytes[0] = 0x00;
		expect(() => parsePngDimensions(bytes)).toThrow(/bad signature/);
	});

	it("rejects a buffer too short for an IHDR header", () => {
		expect(() => parsePngDimensions(new Uint8Array(8))).toThrow(/too short/);
	});

	it("rejects a valid signature whose first chunk is not IHDR", () => {
		const bytes = pngHeader(16, 16);
		bytes[12] = 0x00; // corrupt the "IHDR" chunk type
		expect(() => parsePngDimensions(bytes)).toThrow(/not IHDR/);
	});

	it("rejects a zero dimension", () => {
		expect(() => parsePngDimensions(pngHeader(0, 16))).toThrow(/out of range/);
	});

	it("rejects an absurdly large dimension", () => {
		expect(() => parsePngDimensions(pngHeader(100_000, 16))).toThrow(/out of range/);
	});
});

describe("sha256Hex", () => {
	it("hashes bytes to the known SHA-256 digest", async () => {
		const hash = await sha256Hex(new TextEncoder().encode("abc"));
		expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});

describe("toBase64", () => {
	it("base64-encodes bytes", () => {
		expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
	});
});

const MANIFEST: FixtureManifest = {
	id: "cdn-optimizer",
	version: "1.2.3",
	capabilities: ["network:fetch", "read:content"],
};

describe("buildCodeAnalysisInput", () => {
	it("includes the manifest as a file and carries capabilities as declaredAccess", () => {
		const input = buildCodeAnalysisInput(MANIFEST, '{"id":"cdn-optimizer"}', [
			{ path: "backend.js", content: "export default {}" },
		]);
		expect(input.files[0]).toEqual({ path: "manifest.json", content: '{"id":"cdn-optimizer"}' });
		expect(input.files[1]?.path).toBe("backend.js");
		expect(input.declaredAccess).toEqual(["network:fetch", "read:content"]);
		expect(input.metadata).toEqual({
			name: "cdn-optimizer",
			description: "",
			publisherDid: expect.stringMatching(/^did:/),
			version: "1.2.3",
		});
	});
});

describe("buildImageAnalysisImage", () => {
	it("computes dimensions, hash, and base64 from image bytes", async () => {
		const bytes = pngHeader(41, 41);
		const image = await buildImageAnalysisImage("icon.png", bytes, "icon");
		expect(image.width).toBe(41);
		expect(image.height).toBe(41);
		expect(image.mime).toBe("image/png");
		expect(image.kind).toBe("icon");
		expect(image.sha256).toBe(await sha256Hex(bytes));
		expect(image.dataBase64).toBe(toBase64(bytes));
	});
});
