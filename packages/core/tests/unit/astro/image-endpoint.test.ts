import { beforeEach, describe, expect, it, vi } from "vitest";

const transform = vi.fn();

vi.mock("astro:assets", () => ({
	getConfiguredImageService: vi.fn(() =>
		Promise.resolve({
			transform,
			parseURL: vi.fn((_url: URL, _config: unknown) => ({
				width: 150,
				height: 150,
				format: "webp",
			})),
		}),
	),
	imageConfig: {},
}));

vi.mock("astro/assets/endpoint/generic", () => ({
	GET: vi.fn(() => Promise.resolve(new Response("generic", { status: 200 }))),
}));

import { GET } from "../../../src/astro/image-endpoint.js";
import { MUTABLE_MEDIA_CACHE_CONTROL } from "../../../src/media/image-endpoint.js";

function buildContext(
	request: Request,
	storage: { download: ReturnType<typeof vi.fn> },
): Parameters<typeof GET>[0] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for the endpoint
	return {
		request,
		url: new URL(request.url),
		locals: { emdash: { storage } },
	} as unknown as Parameters<typeof GET>[0];
}

describe("GET /_image over EmDash media", () => {
	beforeEach(() => {
		transform.mockClear();
	});

	it("serves a transformed image with weak validators", async () => {
		const lastModified = new Date("2026-01-15T12:00:00.000Z");
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});
		const download = vi.fn().mockResolvedValue({
			body,
			contentType: "image/png",
			size: 3,
			lastModified,
		});
		transform.mockResolvedValue({ data: new Uint8Array([4, 5, 6]), format: "webp" });
		const request = new Request(
			"http://localhost/_image?href=/_emdash/api/media/file/key.png&w=150",
		);

		const response = await GET(buildContext(request, { download }));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
		expect(response.headers.get("Content-Type")).toBe("image/webp");
		expect(response.headers.get("ETag")).toContain(String(lastModified.getTime()));
		expect(response.headers.get("ETag")).toContain("w=150");
		expect(response.headers.get("Last-Modified")).toBe(lastModified.toUTCString());
	});

	it("returns 304 when If-None-Match matches the transform ETag", async () => {
		const lastModified = new Date("2026-01-15T12:00:00.000Z");
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});
		const download = vi.fn().mockResolvedValue({
			body,
			contentType: "image/png",
			size: 3,
			lastModified,
		});
		transform.mockResolvedValue({ data: new Uint8Array([4, 5, 6]), format: "webp" });
		const request = new Request(
			"http://localhost/_image?href=/_emdash/api/media/file/key.png&w=150",
		);
		const first = await GET(buildContext(request, { download }));
		const etag = first.headers.get("ETag")!;

		const conditional = new Request(
			"http://localhost/_image?href=/_emdash/api/media/file/key.png&w=150",
			{ headers: { "If-None-Match": etag } },
		);
		const response = await GET(buildContext(conditional, { download }));

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(etag);
		expect(transform).toHaveBeenCalledTimes(1);
	});

	it("returns 304 for the original fallback when If-None-Match matches", async () => {
		const lastModified = new Date("2026-01-15T12:00:00.000Z");
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});
		const download = vi.fn().mockResolvedValue({
			body,
			contentType: "image/png",
			size: 3,
			lastModified,
		});
		// No transform params, so the endpoint streams the original.
		const request = new Request("http://localhost/_image?href=/_emdash/api/media/file/key.png");
		const first = await GET(buildContext(request, { download }));
		const etag = first.headers.get("ETag")!;

		const conditional = new Request(
			"http://localhost/_image?href=/_emdash/api/media/file/key.png",
			{ headers: { "If-None-Match": etag } },
		);
		const response = await GET(buildContext(conditional, { download }));

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(etag);
	});
});
