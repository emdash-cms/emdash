import { afterEach, describe, expect, it, vi } from "vitest";

import { createCroppedFilename, createCroppedImageFile } from "../../src/lib/crop-image.js";

const ANIMATED_WEBP_BASE64 =
	"UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAD/////AQBBTk1GJgAAAAAAAAAAAAAAAAAAAGQAAAJWUDhMDgAAAC8AAAAABxAR/Q9ERP8DQU5NRioAAAAAAAAAAAAAAAAAAABkAAAAVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

afterEach(() => {
	vi.restoreAllMocks();
});

function createSourceCanvas(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = 4;
	canvas.height = 2;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "rgb(255, 0, 0)";
	context.fillRect(0, 0, 2, 2);
	context.fillStyle = "rgb(0, 0, 255)";
	context.fillRect(2, 0, 2, 2);
	return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				reject(new Error("Canvas encoding failed"));
				return;
			}
			resolve(blob);
		}, type);
	});
}

async function pixels(
	file: Blob,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
	const bitmap = await createImageBitmap(file);
	try {
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context = canvas.getContext("2d")!;
		context.drawImage(bitmap, 0, 0);
		return {
			width: bitmap.width,
			height: bitmap.height,
			data: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
		};
	} finally {
		bitmap.close();
	}
}

describe("createCroppedFilename", () => {
	it.each([
		["photo.jpg", "square", 800, 800, "photo-square.jpg"],
		["photo-cropped-cropped.jpg", "16:9", 1600, 900, "photo-16x9.jpg"],
		["hand-cropped.jpg", "16:9", 1600, 900, "hand-cropped-16x9.jpg"],
		["photo-square.jpg", "4:3", 1200, 900, "photo-square-4x3.jpg"],
		["wallpaper-1920x1080.jpg", "square", 800, 800, "wallpaper-1920x1080-square.jpg"],
		["photo.jpg", "freeform", 1180, 760, "photo-1180x760.jpg"],
		["photo.jpg", "original", 1200, 800, "photo-1200x800.jpg"],
		["photo-square.jpg", "square", 800, 800, "photo-square.jpg"],
	] as const)("names %s cropped as %s", (filename, mode, width, height, expected) => {
		expect(createCroppedFilename(filename, mode, { width, height })).toBe(expected);
	});
});

describe("createCroppedImageFile", () => {
	it("creates the selected pixels without modifying the source file", async () => {
		const sourceBlob = await canvasBlob(createSourceCanvas(), "image/png");
		const sourceFile = new File([sourceBlob], "source.png", { type: "image/png" });
		const sourceBytes = new Uint8Array(await sourceFile.arrayBuffer());
		const bitmap = await createImageBitmap(sourceFile);

		const cropped = await createCroppedImageFile(
			bitmap,
			{ x: 2, y: 0, width: 2, height: 2 },
			"source-cropped.png",
			"image/png",
		);
		bitmap.close();

		const output = await pixels(cropped);
		expect({ width: output.width, height: output.height }).toEqual({ width: 2, height: 2 });
		for (let offset = 0; offset < output.data.length; offset += 4) {
			expect(output.data.slice(offset, offset + 4)).toEqual(
				new Uint8ClampedArray([0, 0, 255, 255]),
			);
		}
		expect(new Uint8Array(await sourceFile.arrayBuffer())).toEqual(sourceBytes);
	});

	it.each([
		["image/jpeg", "crop.jpg"],
		["image/png", "crop.png"],
		["image/webp", "crop.webp"],
	] as const)("keeps the %s MIME type and filename", async (mimeType, filename) => {
		const file = await createCroppedImageFile(
			createSourceCanvas(),
			{ x: 0, y: 0, width: 2, height: 2 },
			filename,
			mimeType,
		);

		expect(file.type).toBe(mimeType);
		expect(file.name).toBe(filename);
		expect(file.size).toBeGreaterThan(0);
	});

	it("rejects when the browser returns no encoded blob", async () => {
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
			callback(null);
		});

		await expect(
			createCroppedImageFile(
				createSourceCanvas(),
				{ x: 0, y: 0, width: 2, height: 2 },
				"crop.png",
				"image/png",
			),
		).rejects.toThrow("could not be encoded");
	});

	it("rejects when the browser changes the requested MIME type", async () => {
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
			callback(new Blob(["png"], { type: "image/png" }));
		});

		await expect(
			createCroppedImageFile(
				createSourceCanvas(),
				{ x: 0, y: 0, width: 2, height: 2 },
				"crop.jpg",
				"image/jpeg",
			),
		).rejects.toThrow("MIME type");
	});

	it("turns an animated WebP source into a static WebP", async () => {
		const animatedBytes = Uint8Array.from(atob(ANIMATED_WEBP_BASE64), (char) => char.charCodeAt(0));
		const inputChunks = String.fromCharCode(...animatedBytes);
		expect(inputChunks).toContain("ANIM");
		const bitmap = await createImageBitmap(new Blob([animatedBytes], { type: "image/webp" }));

		const output = await createCroppedImageFile(
			bitmap,
			{ x: 0, y: 0, width: 1, height: 1 },
			"still.webp",
			"image/webp",
		);
		bitmap.close();

		const outputBytes = new Uint8Array(await output.arrayBuffer());
		expect(output.type).toBe("image/webp");
		expect(String.fromCharCode(...outputBytes)).not.toContain("ANIM");
		expect(await pixels(output)).toMatchObject({ width: 1, height: 1 });
	});
});
