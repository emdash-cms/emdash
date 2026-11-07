import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("GET /_image outside EmDash storage", () => {
	const download = vi.fn();

	it.each([
		"https://attacker.example/_emdash/api/media/file/nested/key.png",
		"//attacker.example/_emdash/api/media/file/nested/key.png",
		"http:attacker.example/_emdash/api/media/file/nested/key.png",
		"http:/attacker.example/_emdash/api/media/file/nested/key.png",
	])("does not load internal media from another host (%s)", async (href) => {
		const request = new Request(
			`https://site.example/_image?href=${encodeURIComponent(href)}&w=150`,
		);

		const response = await GET(buildContext(request, { download }));

		expect(response.status).toBe(404);
		expect(await response.text()).not.toBe("generic");
	});

	it.each([
		"/_emdash/api/media/file/nested/key.png",
		"http://127.0.0.1:9000/_emdash/api/media/file/nested/key.png",
	])("does not fetch internal media it cannot read from storage (%s)", async (href) => {
		const request = new Request(
			`http://127.0.0.1:9000/_image?href=${encodeURIComponent(href)}&w=150`,
		);

		const response = await GET(buildContext(request, { download }));

		expect(response.status).toBe(404);
		expect(await response.text()).not.toBe("generic");
	});

	it.each(["https://cdn.example.com/key.png", "/_astro/logo.png"])(
		"delegates other sources to the stock endpoint (%s)",
		async (href) => {
			const request = new Request(`http://localhost/_image?href=${encodeURIComponent(href)}&w=150`);

			const response = await GET(buildContext(request, { download }));

			expect(await response.text()).toBe("generic");
		},
	);

	it("does not load cross-host internal media when storage is unavailable", async () => {
		const request = new Request(
			`http://localhost/_image?href=${encodeURIComponent("https://attacker.example/_emdash/api/media/file/key.png")}&w=150`,
		);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for the endpoint
		const ctx = { request, url: new URL(request.url), locals: {} } as unknown as Parameters<
			typeof GET
		>[0];

		expect((await GET(ctx)).status).toBe(404);
	});
});

describe("GET /_image when the image service cannot transform", () => {
	const download = vi.fn().mockImplementation(async () => ({
		body: new Response(new Uint8Array([1, 2, 3])).body,
		contentType: "image/jpeg",
		size: 3,
	}));
	const request = (headers?: HeadersInit) =>
		new Request("http://localhost/_image?href=/_emdash/api/media/file/key.jpg&w=150&f=webp", {
			headers,
		});
	const missingSharp = () =>
		Object.assign(new Error("Could not find Sharp"), { name: "MissingSharp" });

	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[
			Symbol.for("emdash:image-endpoint:missing-sharp")
		];
		transform.mockReset();
		vi.restoreAllMocks();
	});

	it("serves the stored original when sharp is not installed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		transform.mockRejectedValueOnce(missingSharp());

		const response = await GET(buildContext(request(), { download }));

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/jpeg");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("revalidates the served original without retrying the transform", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		transform.mockRejectedValue(missingSharp());

		const first = await GET(buildContext(request(), { download }));
		const etag = first.headers.get("ETag");
		expect(etag).toBeTruthy();

		const second = await GET(buildContext(request({ "If-None-Match": etag! }), { download }));
		const third = await GET(buildContext(request(), { download }));

		expect(second.status).toBe(304);
		expect(third.status).toBe(200);
		expect(new Uint8Array(await third.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(transform).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledTimes(1);
	});

	it("fails when the image itself cannot be transformed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		transform.mockRejectedValueOnce(new Error("Input buffer contains unsupported image format"));

		const response = await GET(buildContext(request(), { download }));

		expect(response.status).toBe(500);
	});
});
