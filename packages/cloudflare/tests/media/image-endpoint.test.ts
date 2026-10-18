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
