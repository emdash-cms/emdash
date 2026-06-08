import { afterEach, describe, expect, it, vi } from "vitest";

async function loadRoute(
	transformMedia: unknown,
	transformableContentTypes: string[] | null | undefined,
) {
	vi.resetModules();
	vi.doMock(
		"virtual:emdash/media-transform",
		() => ({ transformMedia, transformableContentTypes }),
		{ virtual: true },
	);
	return import("../../../src/astro/routes/api/media/file/[...key].js");
}

function mediaContext(contentType = "image/png") {
	const download = vi.fn().mockResolvedValue({
		body: new Uint8Array([1, 2, 3]),
		contentType,
		size: 3,
	});

	return {
		context: {
			params: { key: "image.png" },
			request: new Request("https://example.com/_emdash/api/media/file/image.png?width=800", {
				headers: { accept: "image/avif,image/webp" },
			}),
			locals: {
				emdash: {
					storage: { download },
				},
			},
		},
		download,
	};
}

describe("media file route transforms", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("virtual:emdash/media-transform");
	});

	it("returns transformed media when the configured adapter succeeds", async () => {
		const transformMedia = vi.fn().mockResolvedValue({
			body: new Uint8Array([9, 8]),
			contentType: "image/webp",
			headers: { Vary: "Accept" },
		});
		const { GET } = await loadRoute(transformMedia, ["image/png"]);
		const { context } = mediaContext();

		const response = await GET(context as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/webp");
		expect(response.headers.get("Vary")).toBe("Accept");
		expect(response.headers.get("Content-Length")).toBeNull();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9, 8]));
		expect(transformMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				contentType: "image/png",
				key: "image.png",
				size: 3,
			}),
		);
	});

	it("serves original media when the adapter fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const transformMedia = vi.fn().mockRejectedValue(new Error("transform unavailable"));
		const { GET } = await loadRoute(transformMedia, ["image/png"]);
		const { context } = mediaContext();

		const response = await GET(context as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(response.headers.get("Vary")).toBeNull();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(errorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "emdash_media_transform_failed",
				key: "image.png",
				error: "transform unavailable",
			}),
		);
	});

	it("skips the adapter for non-matching content types", async () => {
		const transformMedia = vi.fn();
		const { GET } = await loadRoute(transformMedia, ["image/png"]);
		const { context } = mediaContext("image/gif");

		const response = await GET(context as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/gif");
		expect(transformMedia).not.toHaveBeenCalled();
	});
});
