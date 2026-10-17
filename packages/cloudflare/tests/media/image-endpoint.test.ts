import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fakeEnv } = vi.hoisted(() => ({ fakeEnv: {} as Record<string, unknown> }));

vi.mock("cloudflare:workers", () => ({ env: fakeEnv }));
vi.mock("@astrojs/cloudflare/image-transform-endpoint", () => ({
	GET: () => new Response("adapter"),
}));

import { GET } from "../../src/image-endpoint.js";

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
