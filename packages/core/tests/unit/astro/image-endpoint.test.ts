import type { APIContext } from "astro";
import sharpService from "astro/assets/services/sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMediaRequests } from "../../utils/media-route-cache.js";

const transform = vi.fn();
let configuredService: typeof sharpService | undefined;
const imageConfig = vi.hoisted(() => ({
	dangerouslyProcessSVG: true,
	assetQueryParams: undefined as URLSearchParams | undefined,
	service: { entrypoint: "astro/assets/services/sharp", config: {} },
}));
const virtualConfig = vi.hoisted(() => ({}) as { routeCacheProvider?: string });

vi.mock("virtual:emdash/config", () => ({ default: virtualConfig }));

vi.mock("astro:assets", () => ({
	getConfiguredImageService: vi.fn(() =>
		Promise.resolve(
			configuredService ?? {
				transform,
				parseURL: vi.fn((url: URL, _config: unknown) =>
					url.searchParams.has("w")
						? {
								width: 150,
								height: 150,
								format: "webp",
							}
						: undefined,
				),
			},
		),
	),
	imageConfig,
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
	cache: Pick<APIContext["cache"], "enabled" | "set"> = routeCache(),
	logger = { warn: vi.fn() },
): Parameters<typeof GET>[0] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for the endpoint
	return {
		request,
		url: new URL(request.url),
		locals: { emdash: { storage } },
		cache,
		logger,
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
		transform.mockReset();
		configuredService = undefined;
		imageConfig.assetQueryParams = undefined;
		imageConfig.service.entrypoint = "astro/assets/services/sharp";
		delete virtualConfig.routeCacheProvider;
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

	it.each([1011, 1012, 1013])(
		"serves a transform for a %i-character key and caches only purgeable tags",
		async (length) => {
			const key = `${"a".repeat(length - 4)}.png`;
			transform.mockResolvedValue({ data: new Uint8Array([4, 5, 6]), format: "webp" });
			const cache = routeCache();
			const params = new URLSearchParams({
				href: `/_emdash/api/media/file/${key}`,
				w: "150",
			});
			const response = await GET(
				buildContext(
					new Request(`http://localhost/_image?${params}`),
					{ download: pngDownload() },
					cache,
				),
			);

			expect(response.status).toBe(200);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
			if (length === 1011) {
				expect(cache.set).toHaveBeenCalledWith({
					maxAge: 31_536_000,
					tags: [`emdash:media:${key}`],
				});
			} else {
				expect(cache.set).not.toHaveBeenCalled();
			}
		},
	);

	it("serves the same response without touching a disabled route cache", async () => {
		transform.mockResolvedValue({ data: new Uint8Array([4, 5, 6]), format: "webp" });
		const cache = { enabled: false, set: vi.fn() };
		const request = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
		);

		const response = await GET(buildContext(request, { download: pngDownload() }, cache));

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
		expect(cache.set).not.toHaveBeenCalled();
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

	it("preserves adapter asset parameters without redirecting a canonical image URL", async () => {
		imageConfig.assetQueryParams = new URLSearchParams({ dpl: "abc" });
		transform.mockResolvedValue({ data: new Uint8Array([4, 5, 6]), format: "webp" });
		const request = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150&dpl=abc",
		);

		const response = await GET(buildContext(request, { download: pngDownload() }));

		expect(response.status).toBe(200);
		expect(response.headers.has("Location")).toBe(false);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
	});

	it("leaves non-EmDash images to Astro's endpoint without redirecting", async () => {
		const request = new Request("http://localhost/_image?w=150&href=%2F_astro%2Flogo.png&v=2");

		const response = await GET(buildContext(request, { download: pngDownload() }));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("generic");
	});

	it("does not cache a failed transform", async () => {
		transform.mockRejectedValue(new Error("unsupported image"));
		const cache = routeCache();
		const request = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
		);

		const response = await GET(buildContext(request, { download: pngDownload() }, cache));

		expect(response.status).toBe(500);
		expect(cache.set).not.toHaveBeenCalled();
	});

	function rasterSource() {
		return vi.fn((key: string) => {
			const color = key === "red.svg" ? "red" : "blue";
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="${color}"/></svg>`;
			return Promise.resolve({
				body: new Response(svg).body!,
				contentType: "image/svg+xml",
				size: new TextEncoder().encode(svg).byteLength,
				lastModified: new Date("2026-01-15T12:00:00.000Z"),
			});
		});
	}

	it.each([
		{ key: "red.svg", width: 16 },
		{ key: "blue.svg", width: 8 },
	])(
		"serves distinct $key at width $width with a page-only memory cache key",
		async ({ key, width }) => {
			virtualConfig.routeCacheProvider = "memory";
			configuredService = sharpService;
			const serve = memoryMediaRequests();
			const storage = { download: rasterSource() };
			const firstRequest = new Request(
				"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fred.svg&w=8&f=png",
			);
			const first = await serve(firstRequest, (cache) =>
				GET(buildContext(firstRequest, storage, cache)),
			);
			expect(first.status).toBe(200);
			const firstBytes = new Uint8Array(await first.arrayBuffer());
			expect(new DataView(firstBytes.buffer).getUint32(16)).toBe(8);
			const request = new Request(
				`http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2F${key}&w=${width}&f=png`,
			);

			const response = await serve(request, (cache) => GET(buildContext(request, storage, cache)));

			expect(response.status).toBe(200);
			const bytes = new Uint8Array(await response.arrayBuffer());
			expect(bytes).not.toEqual(firstBytes);
			expect(new DataView(bytes.buffer).getUint32(16)).toBe(width);
			expect(response.headers.get("X-Astro-Cache")).not.toBe("HIT");
		},
	);

	it("revalidates a transformed image after the first request with the memory provider", async () => {
		virtualConfig.routeCacheProvider = "memory";
		configuredService = sharpService;
		const serve = memoryMediaRequests();
		const storage = { download: rasterSource() };
		const url = "http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fred.svg&w=8&f=png";
		const request = new Request(url);
		const first = await serve(request, (cache) => GET(buildContext(request, storage, cache)));
		expect(first.status).toBe(200);
		const etag = first.headers.get("ETag")!;
		const conditional = new Request(url, { headers: { "If-None-Match": etag } });

		const response = await serve(conditional, (cache) =>
			GET(buildContext(conditional, storage, cache)),
		);

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(etag);
		expect(response.body).toBeNull();
		expect(response.headers.get("X-Astro-Cache")).not.toBe("HIT");
	});

	it.each([
		"/_emdash/api/media/file/red.svg?buster=1",
		"/_emdash/api/media/file/red.svg?buster=2",
		"/_emdash/api/media/file/red.svg?_emdash_media=hash",
		"/_emdash/api/media/file/red.svg#preview",
		"/_emdash/api/media/file/red.svg?",
		"https://other.test/_emdash/api/media/file/red.svg",
	])("renders source alias %s without caching another variant", async (href) => {
		configuredService = sharpService;
		const search = new URLSearchParams({ href, w: "8", f: "png" });
		const request = new Request(`http://localhost/_image?${search}`);
		const cache = routeCache();

		const response = await GET(buildContext(request, { download: rasterSource() }, cache));

		expect(response.status).toBe(200);
		expect(response.headers.has("Location")).toBe(false);
		expect(new DataView(await response.arrayBuffer()).getUint32(16)).toBe(8);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"preserves custom thumbnail parameters with route caching enabled=%s",
		async (enabled) => {
			imageConfig.service.entrypoint = "./thumbnail-service.ts";
			configuredService = {
				...sharpService,
				parseURL(url) {
					return {
						src: url.searchParams.get("href")!,
						width: url.searchParams.get("size") === "thumbnail" ? 8 : 40,
						format: "png",
					};
				},
			};
			const request = new Request(
				"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fred.svg&size=thumbnail",
			);
			const cache = { enabled, set: vi.fn() };

			const response = await GET(buildContext(request, { download: rasterSource() }, cache));

			expect(response.status).toBe(200);
			expect(response.headers.has("Location")).toBe(false);
			expect(response.headers.get("Content-Type")).toBe("image/png");
			const png = new DataView(await response.arrayBuffer());
			expect(png.getUint32(16)).toBe(8);
			expect(png.getUint32(20)).toBe(4);
			expect(cache.set).not.toHaveBeenCalled();
		},
	);

	it("serves the original when the image service cannot optimize it", async () => {
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
			lastModified: new Date("2026-01-15T12:00:00.000Z"),
		});
		// Astro's sharp service warns through the logger it is given and passes the
		// input through when it cannot process the format.
		transform.mockImplementationOnce(
			async (
				input: Uint8Array,
				_transform: unknown,
				_config: unknown,
				logger: { warn(message: string): void },
			) => {
				logger.warn("could not optimize");
				return { data: input, format: "png" };
			},
		);
		const logger = { warn: vi.fn() };
		const request = new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.png&w=150",
		);

		const response = await GET(buildContext(request, { download }, routeCache(), logger));

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(logger.warn).toHaveBeenCalledWith("could not optimize");
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
		lastModified: new Date("2026-01-15T12:00:00.000Z"),
	}));
	const request = (headers?: HeadersInit) =>
		new Request(
			"http://localhost/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fkey.jpg&w=150&f=webp",
			{
				headers,
			},
		);
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
		const cache = routeCache();

		const response = await GET(buildContext(request(), { download }, cache));

		expect(response.status).toBe(200);
		expect(cache.set.mock.calls).toEqual([[false]]);
		expect(response.headers.get("Last-Modified")).toBeNull();
		expect(response.headers.get("Content-Type")).toBe("image/jpeg");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("revalidates the served original without retrying the transform", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		transform.mockRejectedValue(missingSharp());

		const first = await GET(buildContext(request(), { download }));
		const etag = first.headers.get("ETag");
		expect(etag).toBeTruthy();

		const cache = routeCache();
		const second = await GET(
			buildContext(request({ "If-None-Match": etag! }), { download }, cache),
		);
		const third = await GET(buildContext(request(), { download }));

		expect(second.status).toBe(304);
		expect(second.headers.get("Last-Modified")).toBeNull();
		expect(cache.set.mock.calls).toEqual([[false]]);
		expect(third.status).toBe(200);
		expect(new Uint8Array(await third.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(transform).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledTimes(1);
	});

	it("leaves a disabled route cache untouched when serving the original", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		transform.mockRejectedValueOnce(missingSharp());
		const cache = { enabled: false, set: vi.fn() };

		const response = await GET(buildContext(request(), { download }, cache));
		const repeat = await GET(buildContext(request(), { download }, cache));

		expect(response.status).toBe(200);
		expect(repeat.status).toBe(200);
		expect(transform).toHaveBeenCalledTimes(1);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("fails when the image itself cannot be transformed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		transform.mockRejectedValueOnce(new Error("Input buffer contains unsupported image format"));

		const response = await GET(buildContext(request(), { download }));

		expect(response.status).toBe(500);
	});
});
