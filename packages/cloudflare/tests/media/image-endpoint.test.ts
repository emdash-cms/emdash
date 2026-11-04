import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fakeEnv, adapterGET } = vi.hoisted(() => ({
	fakeEnv: {} as Record<string, unknown>,
	adapterGET: vi.fn(async () => new Response("adapter", { status: 418 })),
}));

vi.mock("cloudflare:workers", () => ({ env: fakeEnv }));
vi.mock("@astrojs/cloudflare/image-transform-endpoint", () => ({ GET: adapterGET }));
vi.mock(
	"emdash/media/image-endpoint",
	async () => import("../../../core/src/media/image-endpoint.js"),
);

import { GET } from "../../src/image-endpoint.js";

const sourceBytes = new TextEncoder().encode("source");
const transformedBytes = new TextEncoder().encode("transformed");

function context(query: string, contentType = "image/jpeg") {
	const input = {
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(sourceBytes);
				controller.close();
			},
		}),
		contentType,
		size: sourceBytes.length,
		downloads: 0,
	};
	const storage = {
		download: vi.fn(async () => {
			input.downloads++;
			return input;
		}),
	};
	return {
		input,
		storage,
		ctx: {
			request: new Request(
				`https://example.test/_image?href=/_emdash/api/media/file/photo.jpg&${query}`,
			),
			locals: { emdash: { storage } },
		},
	};
}

function installImages() {
	const transform = vi.fn();
	const output = vi.fn(async (options: ImageOutputOptions) => ({
		response: () =>
			new Response(transformedBytes, {
				headers: { "Content-Type": options.format },
			}),
	}));
	const images = {
		input: vi.fn(() => ({
			transform: (params: ImageTransform) => {
				transform(params);
				return { output };
			},
		})),
	};
	fakeEnv.IMAGES = images;
	return { images, transform, output };
}

afterEach(() => {
	for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
	vi.clearAllMocks();
});

describe("Cloudflare image endpoint", () => {
	it.each([
		["low", 25],
		["mid", 50],
		["high", 80],
		["max", 100],
		["70.6", 71],
		["80.5", 81],
		["0", 1],
		["101", 100],
		["150", 100],
	])("passes parsed quality %s to Images", async (q, quality) => {
		const { images, transform, output } = installImages();
		const { ctx } = context(`w=120&q=${q}`);

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(images.input).toHaveBeenCalledOnce();
		expect(transform).toHaveBeenCalledWith({ width: 120 });
		expect(output).toHaveBeenCalledWith({ format: "image/webp", quality });
		expect(await response.text()).toBe("transformed");
	});

	it("uses the Images default quality for an omitted q", async () => {
		const { output } = installImages();
		const { ctx } = context("w=120");

		await GET(ctx as never);

		expect(output).toHaveBeenCalledWith({ format: "image/webp", quality: 85 });
	});

	it.each(["w=120&q=unknown", "", "w=120&f=gif"])(
		"preserves the original fallback for malformed query %s",
		async (query) => {
			const { images } = installImages();
			const { ctx } = context(query);

			const response = await GET(ctx as never);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("source");
			expect(images.input).not.toHaveBeenCalled();
		},
	);

	it("streams the original when Images is unavailable", async () => {
		const { ctx } = context("w=120&q=70");

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("source");
		expect(adapterGET).not.toHaveBeenCalled();
	});

	it.each(["w=120&q=70", "w=120&q=unknown"])(
		"passes non-image media through unchanged for %s",
		async (query) => {
			installImages();
			const { ctx } = context(query, "application/pdf");

			const response = await GET(ctx as never);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("source");
		},
	);
});

interface TrackedBody {
	stream: ReadableStream<Uint8Array>;
	cancelled: () => boolean;
}

function trackedBody(): TrackedBody {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, cancelled: () => cancelled };
}

const fakeImages = {
	input: (stream: ReadableStream<Uint8Array>) => ({
		transform: () => ({
			output: async () => ({ response: () => new Response(stream) }),
		}),
	}),
};

const failingImages = {
	input: () => ({
		transform: () => ({
			output: async () => {
				throw new Error("unsupported image");
			},
		}),
	}),
};

async function request(options: {
	contentType: string;
	query: string;
	method?: string;
	headers?: Record<string, string>;
}): Promise<{ response: Response; body: TrackedBody }> {
	const body = trackedBody();
	const storage = {
		download: async () => ({
			body: body.stream,
			contentType: options.contentType,
			size: 3,
			lastModified: new Date("2026-01-01T00:00:00Z"),
		}),
	};
	const url = `https://site.test/_image?href=/_emdash/api/media/file/a.bin&${options.query}`;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the endpoint reads only request and locals
	const ctx = {
		request: new Request(url, { method: options.method ?? "GET", headers: options.headers }),
		locals: { emdash: { storage } },
	} as unknown as APIContext;
	const response = await GET(ctx);
	return { response, body };
}

describe("cloudflare image endpoint storage body", () => {
	afterEach(() => {
		delete fakeEnv.IMAGES;
		vi.restoreAllMocks();
	});

	it.each([
		["a non-image", "application/pdf", "w=100", false],
		["an image without an Images binding", "image/png", "w=100", false],
		["an image with invalid transform params", "image/png", "w=abc", true],
		["a transformed image", "image/png", "w=100&f=webp", true],
	])(
		"cancels the download for a conditional GET of %s",
		async (_label, contentType, query, binding) => {
			if (binding) fakeEnv.IMAGES = fakeImages;
			const { response, body } = await request({
				contentType,
				query,
				headers: { "If-None-Match": "*" },
			});
			expect(response.status).toBe(304);
			expect(body.cancelled()).toBe(true);
		},
	);

	it.each([
		["a non-image", "application/pdf", "w=100"],
		["an image without an Images binding", "image/png", "w=100"],
	])(
		"cancels the download and sends no body for a HEAD of %s",
		async (_label, contentType, query) => {
			const { response, body } = await request({ contentType, query, method: "HEAD" });
			expect(response.status).toBe(200);
			expect(response.body).toBeNull();
			expect(response.headers.get("Content-Type")).toBe(contentType);
			expect(body.cancelled()).toBe(true);
		},
	);

	it("streams the original body for a GET of a non-image", async () => {
		const { response, body } = await request({ contentType: "application/pdf", query: "w=100" });
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(body.cancelled()).toBe(false);
	});

	it("hands the download to the Images binding for a transform", async () => {
		fakeEnv.IMAGES = fakeImages;
		const { response, body } = await request({ contentType: "image/png", query: "w=100&f=webp" });
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(body.cancelled()).toBe(false);
	});

	it("cancels the download when the Images binding fails without reading it", async () => {
		fakeEnv.IMAGES = failingImages;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { response, body } = await request({ contentType: "image/png", query: "w=100&f=webp" });
		expect(response.status).toBe(500);
		expect(body.cancelled()).toBe(true);
	});
});
