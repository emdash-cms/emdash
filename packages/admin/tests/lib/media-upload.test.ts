import { describe, expect, it, vi } from "vitest";

import { uploadMedia } from "../../src/lib/api/media.js";
import { prepareMediaUploadFile } from "../../src/lib/media-upload.js";

const HEIC_64X64 =
	"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";

function heicFile(): File {
	const bytes = Uint8Array.from(atob(HEIC_64X64), (character) => character.charCodeAt(0));
	return new File([bytes], "fixture.heic", { type: "image/heic" });
}

describe("prepareMediaUploadFile", () => {
	it("converts HEIC uploads to a browser-displayable JPEG", async () => {
		const source = new File([new Uint8Array([1, 2, 3])], "photo.heic", {
			type: "image/heic",
			lastModified: 123,
		});
		const convert = vi.fn(
			async () => new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }),
		);

		const prepared = await prepareMediaUploadFile(source, convert);

		expect(convert).toHaveBeenCalledWith(source);
		expect(prepared.name).toBe("photo.jpg");
		expect(prepared.type).toBe("image/jpeg");
		expect(prepared.lastModified).toBe(source.lastModified);
		expect(new Uint8Array(await prepared.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
	});

	it("produces a JPEG that the browser can display", async () => {
		const prepared = await prepareMediaUploadFile(heicFile());
		const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
			const image = new Image();
			image.onload = () => {
				URL.revokeObjectURL(image.src);
				resolve({ width: image.naturalWidth, height: image.naturalHeight });
			};
			image.onerror = () => {
				URL.revokeObjectURL(image.src);
				reject(new Error("Converted JPEG could not be displayed"));
			};
			image.src = URL.createObjectURL(prepared);
		});

		expect(prepared.type).toBe("image/jpeg");
		expect(dimensions).toEqual({ width: 64, height: 64 });
	});

	it("uploads the converted JPEG through the media API", async () => {
		const originalFetch = globalThis.fetch;
		let uploadedFile: File | null = null;
		globalThis.fetch = vi.fn(async (input, init) => {
			if (String(input).endsWith("/media/upload-url")) {
				return new Response(null, { status: 501 });
			}

			const formData = init?.body;
			if (!(formData instanceof FormData)) throw new Error("Expected a media upload form");
			const file = formData.get("file");
			if (!(file instanceof File)) throw new Error("Expected an uploaded file");
			uploadedFile = file;

			return new Response(
				JSON.stringify({
					data: {
						item: {
							id: "media-1",
							filename: file.name,
							mimeType: file.type,
							url: "/_emdash/api/media/file/media-1.jpg",
							size: file.size,
							createdAt: "2026-07-21T00:00:00.000Z",
						},
					},
				}),
				{ status: 201, headers: { "Content-Type": "application/json" } },
			);
		});

		try {
			const item = await uploadMedia(heicFile());
			expect(item.mimeType).toBe("image/jpeg");
			expect(item.filename).toBe("fixture.jpg");
			expect(uploadedFile).toMatchObject({ name: "fixture.jpg", type: "image/jpeg" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("leaves other uploads unchanged", async () => {
		const source = new File([new Uint8Array([1, 2, 3])], "photo.jpg", {
			type: "image/jpeg",
		});
		const convert = vi.fn();

		const prepared = await prepareMediaUploadFile(source, convert);

		expect(prepared).toBe(source);
		expect(convert).not.toHaveBeenCalled();
	});
});
