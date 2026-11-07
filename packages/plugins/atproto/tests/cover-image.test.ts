import type { PluginContext } from "emdash/plugin";
import { describe, expect, it, vi } from "vitest";

import { uploadCoverImage } from "../src/cover-image.js";

type Fetch = ReturnType<typeof vi.fn>;

const siteUrl = "https://example.com";
const pdsHost = "pds.example.com";
const accessJwt = "access-token";

function blobResponse(status = 200): Response {
	return new Response(
		JSON.stringify({
			blob: {
				$type: "blob",
				ref: { $link: "bafy-uploaded" },
				mimeType: "image/png",
				size: 3,
			},
		}),
		{ status },
	);
}

function imageResponse(
	bytes: Uint8Array = new Uint8Array([137, 80, 78]),
	contentType = "image/png",
): Response {
	return new Response(bytes, {
		headers: { "content-type": contentType },
	});
}

function makeContext(
	options: {
		fetch?: Fetch;
		readBytes?: ReturnType<typeof vi.fn>;
	} = {},
): { ctx: PluginContext; fetch: Fetch; readBytes: ReturnType<typeof vi.fn>; warn: Fetch } {
	const fetch =
		options.fetch ??
		vi.fn().mockResolvedValueOnce(imageResponse()).mockResolvedValueOnce(blobResponse());
	const readBytes = options.readBytes ?? vi.fn();
	const warn = vi.fn();
	const ctx = {
		http: { fetch },
		media: { readBytes },
		log: { warn },
	} as unknown as PluginContext;
	return { ctx, fetch, readBytes, warn };
}

async function uploadResult(
	content: Record<string, unknown>,
	options: Parameters<typeof makeContext>[0] = {},
) {
	const context = makeContext(options);
	const result = await uploadCoverImage(context.ctx, content, siteUrl, pdsHost, accessJwt);
	return { ...context, result };
}

describe("uploadCoverImage", () => {
	it("reads a URL from nested data.cover_image", async () => {
		const { result, fetch, warn } = await uploadResult({ data: { cover_image: "/cover.png" } });

		expect(result.blob?.ref.$link).toBe("bafy-uploaded");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0]?.[0]).toBe("https://example.com/cover.png");
		expect(warn).not.toHaveBeenCalled();
	});

	it("supports the legacy top-level cover_image field", async () => {
		const { result, fetch } = await uploadResult({ cover_image: "https://cdn.example/cover.jpg" });

		expect(result.blob).toBeDefined();
		expect(fetch.mock.calls[0]?.[0]).toBe("https://cdn.example/cover.jpg");
	});

	it("prefers an explicit nested cover_image over featured_image", async () => {
		const readBytes = vi.fn();
		const { result, fetch } = await uploadResult(
			{
				data: {
					cover_image: "https://example.com/explicit.png",
					featured_image: { id: "featured-media" },
				},
			},
			{
				fetch: vi.fn().mockResolvedValueOnce(imageResponse()).mockResolvedValueOnce(blobResponse()),
				readBytes,
			},
		);

		expect(result.blob?.ref.$link).toBe("bafy-uploaded");
		expect(readBytes).not.toHaveBeenCalled();
		expect(fetch.mock.calls[0]?.[0]).toBe("https://example.com/explicit.png");
	});

	it("downloads external provider images over HTTP instead of using a media ID", async () => {
		const readBytes = vi.fn();
		const { result, fetch } = await uploadResult(
			{
				data: {
					featured_image: {
						provider: "external",
						id: "not-a-local-media-id",
						src: "https://cdn.example/image.jpg",
					},
				},
			},
			{ readBytes },
		);

		expect(result.blob).toBeDefined();
		expect(readBytes).not.toHaveBeenCalled();
		expect(fetch.mock.calls[0]?.[0]).toBe("https://cdn.example/image.jpg");
	});

	it.each([
		["non-OK HTTP responses", "https://example.com/missing.png", imageResponse(), 404, 1],
		["invalid URLs", "https://[invalid", imageResponse(), 200, 0],
		["non-HTTP protocols", "data:image/png;base64,AAAA", imageResponse(), 200, 0],
	] as const)(
		"warns and does not upload for %s",
		async (_name, src, response, status, fetchCalls) => {
			const fetch = vi
				.fn()
				.mockImplementationOnce(() =>
					status === 200
						? Promise.resolve(response)
						: Promise.resolve(new Response(null, { status })),
				);
			const { result, warn } = await uploadResult({ data: { cover_image: src } }, { fetch });

			expect(result.blob).toBeUndefined();
			expect(result.warning).toBeDefined();
			expect(fetch).toHaveBeenCalledTimes(fetchCalls);
			expect(warn).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects unsupported MIME types before uploading", async () => {
		const fetch = vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1]), "application/pdf"));
		const { result, warn } = await uploadResult(
			{ cover_image: "https://example.com/cover.pdf" },
			{ fetch },
		);

		expect(result.blob).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it.each(["image/gif", "image/webp"])(
		"uploads %s while preserving its content type",
		async (mimeType) => {
			const fetch = vi
				.fn()
				.mockResolvedValueOnce(imageResponse(new Uint8Array([1, 2]), mimeType))
				.mockResolvedValueOnce(blobResponse());
			const { result } = await uploadResult(
				{ cover_image: `https://example.com/cover.${mimeType.slice(6)}` },
				{ fetch },
			);

			expect(result.blob).toBeDefined();
			expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ "Content-Type": mimeType });
		},
	);

	it("cancels an oversized streaming HTTP response and does not upload", async () => {
		const cancel = vi.fn().mockResolvedValue(undefined);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1_000_001));
			},
		});
		const reader = stream.getReader();
		const read = vi.fn(() => reader.read());
		const body = {
			getReader: () => ({
				read,
				cancel,
				releaseLock: () => reader.releaseLock(),
			}),
		} as unknown as ReadableStream<Uint8Array>;
		const fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { headers: { "content-type": "image/png" } }));
		fetch.mockResolvedValueOnce({ ok: true, body });
		const { result, warn } = await uploadResult(
			{ cover_image: "https://example.com/large.png" },
			{ fetch },
		);

		expect(result.blob).toBeUndefined();
		expect(cancel).toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("accepts exactly 1,000,000 bytes", async () => {
		const bytes = new Uint8Array(1_000_000);
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(imageResponse(bytes))
			.mockResolvedValueOnce(blobResponse());
		const { result } = await uploadResult(
			{ cover_image: "https://example.com/exact.png" },
			{ fetch },
		);

		expect(result.blob).toBeDefined();
		expect(fetch.mock.calls[1]?.[1]?.body).toBeInstanceOf(ArrayBuffer);
		expect((fetch.mock.calls[1]![1]!.body as ArrayBuffer).byteLength).toBe(1_000_000);
	});

	it("does not fall back to HTTP when featured media access fails", async () => {
		const readBytes = vi.fn().mockRejectedValue(new Error("media unavailable"));
		const { result, fetch, warn } = await uploadResult(
			{
				data: {
					featured_image: {
						provider: "local",
						id: "media-1",
						src: "https://example.com/own-site-media.png",
					},
				},
			},
			{ readBytes },
		);

		expect(result.blob).toBeUndefined();
		expect(readBytes).toHaveBeenCalledWith("media-1", { maxBytes: 1_000_000 });
		expect(fetch).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a bare string media ID", "media-1"],
		["a local object src media ID", { provider: "local", id: "", src: "media-1" }],
		[
			"a legacy storage key with a media ID src",
			{ id: "01ABC.jpg", src: "media-1", meta: { storageKey: "01ABC.jpg" } },
		],
	] as const)("reads %s through the byte API", async (_name, featuredImage) => {
		const readBytes = vi
			.fn()
			.mockResolvedValue({ bytes: new Uint8Array([1, 2]), mimeType: "image/png" });
		const { result } = await uploadResult(
			{ data: { featured_image: featuredImage } },
			{ readBytes, fetch: vi.fn().mockResolvedValue(blobResponse()) },
		);

		expect(result.blob).toBeDefined();
		expect(readBytes).toHaveBeenCalledWith("media-1", { maxBytes: 1_000_000 });
	});

	it.each([
		["missing", "Media item is not ready or does not exist", "Select the image again"],
		["not ready", "Media item is not ready or does not exist", "Select the image again"],
	])(
		"reports an actionable warning for a legacy key-only image when media is %s",
		async (_name, message, expected) => {
			const readBytes = vi.fn().mockRejectedValue(new Error(message));
			const { result, fetch, warn } = await uploadResult(
				{ data: { featured_image: { id: "01ABC.jpg", meta: { storageKey: "01ABC.jpg" } } } },
				{ readBytes },
			);

			expect(result.blob).toBeUndefined();
			expect(result.warning).toContain(expected);
			expect(fetch).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		["too large", new RangeError("Media exceeds the requested 1000000-byte limit"), "smaller"],
		["permission denied", new Error("Missing capability: media:bytes:read"), "Approve"],
		[
			"missing media",
			new Error("Media item is not ready or does not exist"),
			"Select the image again",
		],
		["storage failure", new Error("R2 unavailable"), "media storage"],
	])("maps a host %s error to a specific warning", async (_name, error, expected) => {
		const readBytes = vi.fn().mockRejectedValue(error);
		const { result } = await uploadResult(
			{ data: { featured_image: { provider: "local", id: "media-1" } } },
			{ readBytes },
		);

		expect(result.blob).toBeUndefined();
		expect(result.warning).toContain(expected);
		if (_name !== "too large") expect(result.warning).not.toContain("1,000,000");
	});

	it("does nothing when there is no image", async () => {
		const { result, fetch, warn } = await uploadResult({ data: { title: "No image" } });

		expect(result).toEqual({});
		expect(fetch).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("reports upload failures as a nonfatal warning", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(imageResponse())
			.mockResolvedValueOnce(new Response("PDS unavailable", { status: 503 }));
		const { result, warn } = await uploadResult(
			{ cover_image: "https://example.com/cover.png" },
			{ fetch },
		);

		expect(result.blob).toBeUndefined();
		expect(result.warning).toBeDefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
