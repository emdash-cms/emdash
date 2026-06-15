import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET as getMediaFile } from "../../../src/astro/routes/api/media/file/[...key].js";
import { GET as getMediaTransform } from "../../../src/astro/routes/api/media/transform/[...key].js";

function mockMediaContext(key: string | undefined) {
	const download = vi.fn().mockResolvedValue({
		body: new Uint8Array([1, 2, 3]),
		contentType: "image/png",
		size: 3,
	});

	return {
		context: {
			params: { key },
			locals: {
				emdash: {
					storage: { download },
				},
			},
		} as Parameters<typeof getMediaFile>[0],
		download,
	};
}

describe("core media route injection", () => {
	it("uses a catch-all media file route so storage keys can contain slashes", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => {
			routes.push({
				...route,
				entrypoint: route.entrypoint.replaceAll("\\", "/"),
			});
		});

		expect(routes).toContainEqual(
			expect.objectContaining({
				pattern: "/_emdash/api/media/file/[...key]",
				// Route entrypoints resolve to the compiled artifact; `[`/`]` are
				// rewritten to `_` (routeArtifactName) so rolldown's reserved
				// output placeholders can't mangle dynamic-route filenames.
				entrypoint: expect.stringContaining("api/media/file/_...key_"),
			}),
		);
	});
});

describe("media file catch-all route", () => {
	it("passes slash-containing keys through to storage.download", async () => {
		const { context, download } = mockMediaContext("nested/path/file.png");

		const response = await getMediaFile(context);
		expect(response.status).toBe(200);
		expect(download).toHaveBeenCalledWith("nested/path/file.png");
	});

	it("returns not found when the catch-all key is missing", async () => {
		const { context, download } = mockMediaContext(undefined);

		const response = await getMediaFile(context);
		expect(response.status).toBe(404);
		expect(download).not.toHaveBeenCalled();
	});
});

function mockTransformContext(
	key: string | undefined,
	query: string,
	opts: {
		contentType?: string;
		transformImage?: ReturnType<typeof vi.fn>;
	} = {},
) {
	const download = vi.fn().mockResolvedValue({
		body: new Uint8Array([1, 2, 3]),
		contentType: opts.contentType ?? "image/jpeg",
		size: 3,
	});
	const emdash: Record<string, unknown> = { storage: { download } };
	if (opts.transformImage) emdash.transformImage = opts.transformImage;

	return {
		context: {
			params: { key },
			url: new URL(`http://localhost/_emdash/api/media/transform/${key ?? ""}?${query}`),
			locals: { emdash },
		} as unknown as Parameters<typeof getMediaTransform>[0],
		download,
	};
}

describe("media transform route injection", () => {
	it("injects a catch-all transform route", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => {
			routes.push({ ...route, entrypoint: route.entrypoint.replaceAll("\\", "/") });
		});

		expect(routes).toContainEqual(
			expect.objectContaining({
				pattern: "/_emdash/api/media/transform/[...key]",
				entrypoint: expect.stringContaining("api/media/transform/_...key_"),
			}),
		);
	});
});

describe("media transform route handler", () => {
	it("transforms the source via the configured transformer", async () => {
		const transformImage = vi.fn().mockResolvedValue({
			body: new Uint8Array([9, 9]),
			contentType: "image/webp",
		});
		const { context, download } = mockTransformContext("01ABC.jpg", "w=480&f=webp", {
			transformImage,
		});

		const response = await getMediaTransform(context);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/webp");
		expect(download).toHaveBeenCalledWith("01ABC.jpg");
		expect(transformImage).toHaveBeenCalledWith(expect.anything(), {
			width: 480,
			height: undefined,
			format: "webp",
			quality: undefined,
		});
	});

	it("streams the original through when no transformer is configured", async () => {
		const { context, download } = mockTransformContext("01ABC.jpg", "w=480");

		const response = await getMediaTransform(context);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/jpeg");
		expect(download).toHaveBeenCalledWith("01ABC.jpg");
	});

	it("rejects an unsafe (slash-containing) key with 404", async () => {
		const { context, download } = mockTransformContext("nested/path.jpg", "w=480");

		const response = await getMediaTransform(context);
		expect(response.status).toBe(404);
		expect(download).not.toHaveBeenCalled();
	});

	it("rejects invalid params with 400", async () => {
		const { context, download } = mockTransformContext("01ABC.jpg", "h=270");

		const response = await getMediaTransform(context);
		expect(response.status).toBe(400);
		expect(download).not.toHaveBeenCalled();
	});

	it("rejects a non-image source with 400", async () => {
		const transformImage = vi.fn();
		const { context } = mockTransformContext("01ABC.pdf", "w=480", {
			contentType: "application/pdf",
			transformImage,
		});

		const response = await getMediaTransform(context);
		expect(response.status).toBe(400);
		expect(transformImage).not.toHaveBeenCalled();
	});
});
