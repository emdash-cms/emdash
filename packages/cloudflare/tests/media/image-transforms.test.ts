import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CLOUDFLARE_IMAGE_TRANSFORM_TYPES,
	cloudflareImageTransforms,
} from "../../src/media/image-transforms.js";

let testEnv: Record<string, unknown> = {};

vi.mock("cloudflare:workers", () => ({
	get env() {
		return testEnv;
	},
}));

async function loadRuntime() {
	vi.resetModules();
	return import("../../src/media/image-transforms-runtime.js");
}

function stream(bytes = [1, 2, 3]): ReadableStream<Uint8Array> {
	const body = new Response(new Uint8Array(bytes)).body;
	if (!body) throw new Error("Expected response body");
	return body;
}

describe("cloudflareImageTransforms", () => {
	afterEach(() => {
		testEnv = {};
		vi.useRealTimers();
	});

	it("returns a media transform descriptor for the Cloudflare runtime", () => {
		const descriptor = cloudflareImageTransforms({
			binding: "IMAGES",
			timeoutMs: 5000,
			defaultWidth: 1200,
			maxWidth: 2000,
			quality: 80,
		});

		expect(descriptor).toEqual({
			entrypoint: "@emdash-cms/cloudflare/media/image-transforms",
			config: {
				binding: "IMAGES",
				timeoutMs: 5000,
				defaultWidth: 1200,
				maxWidth: 2000,
				quality: 80,
			},
			contentTypes: CLOUDFLARE_IMAGE_TRANSFORM_TYPES,
		});
	});

	it("returns null when the configured Images binding is absent", async () => {
		const { createMediaTransform } = await loadRuntime();
		const transform = createMediaTransform({ binding: "IMAGES" });

		await expect(
			transform({
				body: stream(),
				contentType: "image/png",
				key: "image.png",
				request: new Request("https://example.com/image.png"),
			}),
		).resolves.toBeNull();
	});

	it("passes width, format, and quality options to the Images binding", async () => {
		const outputStream = stream([9, 8, 7]);
		const output = vi.fn().mockResolvedValue({
			image: () => outputStream,
			contentType: () => "image/avif",
		});
		const transformStep = vi.fn(() => ({ output }));
		const input = vi.fn(() => ({ transform: transformStep }));
		testEnv = { IMAGES: { input } };

		const { createMediaTransform } = await loadRuntime();
		const transform = createMediaTransform({
			binding: "IMAGES",
			defaultWidth: 1200,
			maxWidth: 2000,
			quality: 80,
		});

		const result = await transform({
			body: stream(),
			contentType: "image/png",
			key: "image.png",
			request: new Request("https://example.com/image.png?width=5000", {
				headers: { accept: "image/avif,image/webp" },
			}),
		});

		expect(input).toHaveBeenCalledWith(expect.any(ReadableStream));
		expect(transformStep).toHaveBeenCalledWith({ fit: "scale-down", width: 2000 });
		expect(output).toHaveBeenCalledWith({ format: "image/avif", quality: 80 });
		expect(result).toEqual({
			body: outputStream,
			contentType: "image/avif",
			headers: { Vary: "Accept" },
		});
	});

	it("falls back to WebP when AVIF is explicitly rejected", async () => {
		const output = vi.fn().mockResolvedValue({
			image: () => stream([4]),
			contentType: () => "image/webp",
		});
		const transformStep = vi.fn(() => ({ output }));
		testEnv = { IMAGES: { input: vi.fn(() => ({ transform: transformStep })) } };

		const { createMediaTransform } = await loadRuntime();
		const transform = createMediaTransform({ binding: "IMAGES" });

		await transform({
			body: stream(),
			contentType: "image/png",
			key: "image.png",
			request: new Request("https://example.com/image.png", {
				headers: { accept: "image/webp,image/avif;q=0" },
			}),
		});

		expect(output).toHaveBeenCalledWith({ format: "image/webp", quality: 85 });
	});

	it("rejects when the Images transform exceeds the configured timeout", async () => {
		vi.useFakeTimers();
		const output = vi.fn(() => new Promise(() => undefined));
		testEnv = {
			IMAGES: {
				input: vi.fn(() => ({ transform: vi.fn(() => ({ output })) })),
			},
		};

		const { createMediaTransform } = await loadRuntime();
		const transform = createMediaTransform({ binding: "IMAGES", timeoutMs: 10 });
		const promise = transform({
			body: stream(),
			contentType: "image/png",
			key: "image.png",
			request: new Request("https://example.com/image.png"),
		});
		const expectation = expect(promise).rejects.toThrow("Image transform timed out");

		await vi.advanceTimersByTimeAsync(10);
		await expectation;
	});
});
