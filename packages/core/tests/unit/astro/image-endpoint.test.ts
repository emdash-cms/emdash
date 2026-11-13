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

function routeCache() {
	return { enabled: true, set: vi.fn() };
}

function buildContext(
	request: Request,
	storage: { download: ReturnType<typeof vi.fn> },
	cache = routeCache(),
): Parameters<typeof GET>[0] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for the endpoint
	return {
		request,
		url: new URL(request.url),
		locals: { emdash: { storage } },
		cache,
	} as unknown as Parameters<typeof GET>[0];
}

function pngDownload() {
	return vi.fn().mockResolvedValue({
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		}),
		contentType: "image/png",
		size: 3,
		lastModified: new Date("2026-01-15T12:00:00.000Z"),
	});
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
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
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
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
		);
		const first = await GET(buildContext(request, { download }));
		const etag = first.headers.get("ETag")!;

		const conditional = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
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
		const request = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png",
		);
		const first = await GET(buildContext(request, { download }));
		const etag = first.headers.get("ETag")!;

		const conditional = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png",
			{ headers: { "If-None-Match": etag } },
		);
		const response = await GET(buildContext(conditional, { download }));

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(etag);
	});

	it("stores a transformed variant in the route cache under its storage key", async () => {
		transform.mockResolvedValue({ data: new Uint8Array([4, 5, 6]), format: "webp" });
		const cache = routeCache();
		const request = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
		);

		const response = await GET(buildContext(request, { download: pngDownload() }, cache));

		expect(response.status).toBe(200);
		expect(cache.set).toHaveBeenCalledWith({
			maxAge: 31_536_000,
			tags: ["emdash:media:key.png"],
		});
	});

	it("does not cache a 304", async () => {
		transform.mockResolvedValue({ data: new Uint8Array([4, 5, 6]), format: "webp" });
		const url = "http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150";
		const first = await GET(buildContext(new Request(url), { download: pngDownload() }));
		const cache = routeCache();
		const conditional = new Request(url, {
			headers: { "If-None-Match": first.headers.get("ETag")! },
		});

		const response = await GET(buildContext(conditional, { download: pngDownload() }, cache));

		expect(response.status).toBe(304);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("redirects a non-canonical query without reading storage or caching", async () => {
		const download = pngDownload();
		const cache = routeCache();
		const request = new Request(
			"http://localhost/_image?w=150&href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&v=2",
		);

		const response = await GET(buildContext(request, { download }, cache));

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe(
			"/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
		);
		expect(download).not.toHaveBeenCalled();
		expect(transform).not.toHaveBeenCalled();
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("leaves non-EmDash images to Astro's endpoint without redirecting", async () => {
		const request = new Request("http://localhost/_image?w=150&href=%2F_astro%2Flogo.png&v=2");

		const response = await GET(buildContext(request, { download: pngDownload() }));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("generic");
	});
});
