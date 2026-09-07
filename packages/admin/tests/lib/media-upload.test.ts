import { afterEach, expect, it, vi } from "vitest";

import { replaceMediaImage, uploadMedia, uploadToProvider } from "../../src/lib/api/media.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function mediaItemResponse(id: string, filename: string, mimeType = "application/pdf") {
	return Response.json({
		success: true,
		data: {
			item: {
				id,
				filename,
				mimeType,
				url: `/_emdash/api/media/file/${filename}`,
				size: 3,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		},
	});
}

it("deduplicates uploads using the file content hash", async () => {
	const controller = new AbortController();
	let uploadUrlBody: Record<string, unknown> | undefined;
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") {
			if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
			uploadUrlBody = JSON.parse(init.body) as Record<string, unknown>;
			return Response.json({
				success: true,
				data: {
					existing: true,
					mediaId: "existing-media",
					storageKey: "existing.pdf",
					url: "/_emdash/api/media/file/existing.pdf",
				},
			});
		}
		if (url === "/_emdash/api/media/existing-media") {
			return Response.json({
				success: true,
				data: {
					item: {
						id: "existing-media",
						filename: "existing.pdf",
						mimeType: "application/pdf",
						url: "/_emdash/api/media/file/existing.pdf",
						storageKey: "existing.pdf",
						size: 3,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
			});
		}
		return new Response(null, { status: 500 });
	});
	const file = new File([new Uint8Array([97, 98, 99])], "document.pdf", {
		type: "application/pdf",
	});

	const item = await uploadMedia(file, { signal: controller.signal });

	expect(uploadUrlBody?.contentHash).toBe("sha1:a9993e364706816aba3e25717850c26c9cd0d89d");
	expect(item.id).toBe("existing-media");
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(fetch.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
});

it("forces a distinct signed upload when deduplication is disabled", async () => {
	let uploadUrlBody: Record<string, unknown> | undefined;
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") {
			if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
			uploadUrlBody = JSON.parse(init.body) as Record<string, unknown>;
			return Response.json({
				success: true,
				data: {
					uploadUrl: "https://uploads.example/cropped.png",
					method: "PUT",
					headers: { "Content-Type": "image/png" },
					mediaId: "cropped-media",
					storageKey: "cropped.png",
					expiresAt: "2026-01-01T01:00:00.000Z",
				},
			});
		}
		if (url === "https://uploads.example/cropped.png") return new Response(null, { status: 200 });
		if (url === "/_emdash/api/media/cropped-media/confirm") {
			return mediaItemResponse("cropped-media", "cropped.png", "image/png");
		}
		return new Response(null, { status: 500 });
	});

	const item = await uploadMedia(new File(["png"], "cropped.png", { type: "image/png" }), {
		deduplicate: false,
		ensureUniqueFilename: true,
		folderId: "folder-1",
	});

	expect(uploadUrlBody).toMatchObject({
		deduplicate: false,
		ensureUniqueFilename: true,
		folderId: "folder-1",
	});
	expect(uploadUrlBody).not.toHaveProperty("contentHash");
	expect(item.id).toBe("cropped-media");
	expect(fetch).toHaveBeenCalledTimes(3);
});

it("forces a distinct direct upload when deduplication is disabled", async () => {
	let directBody: FormData | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") return new Response(null, { status: 501 });
		if (url === "/_emdash/api/media") {
			directBody = init?.body as FormData;
			return mediaItemResponse("cropped-media", "cropped.png", "image/png");
		}
		return new Response(null, { status: 500 });
	});

	await uploadMedia(new File(["png"], "cropped.png", { type: "image/png" }), {
		deduplicate: false,
		ensureUniqueFilename: true,
		folderId: "folder-1",
	});

	expect(directBody?.get("deduplicate")).toBe("false");
	expect(directBody?.get("ensureUniqueFilename")).toBe("true");
	expect(directBody?.get("folderId")).toBe("folder-1");
});

it("replaces an image through the same-key media endpoint", async () => {
	let replacementBody: FormData | undefined;
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/media%2Fid/replace") {
			replacementBody = init?.body as FormData;
			return mediaItemResponse("media/id", "hero.png", "image/png");
		}
		return new Response(null, { status: 500 });
	});
	const file = new File(["crop"], "hero.png", { type: "image/png" });

	const item = await replaceMediaImage("media/id", file, { width: 600, height: 400 });

	expect(item.id).toBe("media/id");
	expect(fetch).toHaveBeenCalledWith(
		"/_emdash/api/media/media%2Fid/replace",
		expect.objectContaining({ method: "PUT", body: expect.any(FormData) }),
	);
	expect(replacementBody?.get("file")).toBe(file);
	expect(replacementBody?.get("width")).toBe("600");
	expect(replacementBody?.get("height")).toBe("400");
});

it("uploads without deduplication when Web Crypto is unavailable", async () => {
	vi.stubGlobal("crypto", {});
	let uploadUrlBody: Record<string, unknown> | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") {
			if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
			uploadUrlBody = JSON.parse(init.body) as Record<string, unknown>;
			return Response.json({
				success: true,
				data: {
					uploadUrl: "/_emdash/api/media/new-media/upload",
					method: "PUT",
					headers: { "Content-Type": "application/pdf" },
					mediaId: "new-media",
					storageKey: "new.pdf",
					expiresAt: "2026-01-01T01:00:00.000Z",
				},
			});
		}
		if (url === "/_emdash/api/media/new-media/upload") {
			return Response.json({ success: true, data: { uploaded: true, size: 3 } });
		}
		if (url === "/_emdash/api/media/new-media/confirm") {
			return Response.json({
				success: true,
				data: {
					item: {
						id: "new-media",
						filename: "new.pdf",
						mimeType: "application/pdf",
						url: "/_emdash/api/media/file/new.pdf",
						storageKey: "new.pdf",
						size: 3,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
			});
		}
		return new Response(null, { status: 500 });
	});
	const file = new File([new Uint8Array([1, 2, 3])], "new.pdf", {
		type: "application/pdf",
	});

	const item = await uploadMedia(file);

	expect(uploadUrlBody).not.toHaveProperty("contentHash");
	expect(item.id).toBe("new-media");
});

it("uploads without deduplication when content hashing fails", async () => {
	vi.stubGlobal("crypto", {
		subtle: {
			digest: vi.fn().mockRejectedValue(new Error("SHA-1 unavailable")),
		},
	});
	let uploadUrlBody: Record<string, unknown> | undefined;
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") {
			if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
			uploadUrlBody = JSON.parse(init.body) as Record<string, unknown>;
			return new Response(null, { status: 501 });
		}
		if (url === "/_emdash/api/media") {
			return Response.json({
				success: true,
				data: {
					item: {
						id: "new-media",
						filename: "new.pdf",
						mimeType: "application/pdf",
						url: "/_emdash/api/media/file/new.pdf",
						storageKey: "new.pdf",
						size: 3,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
			});
		}
		return new Response(null, { status: 500 });
	});
	const file = new File([new Uint8Array([1, 2, 3])], "new.pdf", {
		type: "application/pdf",
	});

	const item = await uploadMedia(file);

	expect(uploadUrlBody).not.toHaveProperty("contentHash");
	expect(item.id).toBe("new-media");
	expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not deduplicate empty files by their shared hash", async () => {
	let uploadUrlBody: Record<string, unknown> | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") {
			if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
			uploadUrlBody = JSON.parse(init.body) as Record<string, unknown>;
			return Response.json({
				success: true,
				data: {
					uploadUrl: "/_emdash/api/media/empty-media/upload",
					method: "PUT",
					headers: { "Content-Type": "application/pdf" },
					mediaId: "empty-media",
					storageKey: "empty.pdf",
					expiresAt: "2026-01-01T01:00:00.000Z",
				},
			});
		}
		if (url === "/_emdash/api/media/empty-media/upload") {
			return Response.json({ success: true, data: { uploaded: true, size: 0 } });
		}
		if (url === "/_emdash/api/media/empty-media/confirm") {
			return Response.json({
				success: true,
				data: {
					item: {
						id: "empty-media",
						filename: "empty.pdf",
						mimeType: "application/pdf",
						url: "/_emdash/api/media/file/empty.pdf",
						storageKey: "empty.pdf",
						size: 0,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
			});
		}
		return new Response(null, { status: 500 });
	});

	await uploadMedia(new File([], "empty.pdf", { type: "application/pdf" }));

	expect(uploadUrlBody).not.toHaveProperty("contentHash");
});

it("passes one abort signal through the signed upload lifecycle", async () => {
	const controller = new AbortController();
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") {
			return Response.json({
				success: true,
				data: {
					uploadUrl: "https://uploads.example/new.pdf",
					method: "PUT",
					headers: { "Content-Type": "application/pdf" },
					mediaId: "new-media",
					storageKey: "new.pdf",
					expiresAt: "2026-01-01T01:00:00.000Z",
				},
			});
		}
		if (url === "https://uploads.example/new.pdf") return new Response(null, { status: 200 });
		if (url === "/_emdash/api/media/new-media/confirm") {
			return mediaItemResponse("new-media", "new.pdf");
		}
		return new Response(null, { status: 500 });
	});

	await uploadMedia(new File(["pdf"], "new.pdf", { type: "application/pdf" }), {
		signal: controller.signal,
	});

	expect(fetch).toHaveBeenCalledTimes(3);
	expect(fetch.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
});

it("passes the abort signal to the direct upload fallback", async () => {
	const controller = new AbortController();
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") return new Response(null, { status: 501 });
		if (url === "/_emdash/api/media") return mediaItemResponse("direct-media", "direct.pdf");
		return new Response(null, { status: 500 });
	});

	await uploadMedia(new File(["pdf"], "direct.pdf", { type: "application/pdf" }), {
		signal: controller.signal,
	});

	expect(fetch).toHaveBeenCalledTimes(2);
	expect(fetch.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
});

it("passes the abort signal to provider uploads", async () => {
	const controller = new AbortController();
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(mediaItemResponse("provider-media", "provider.pdf"));

	await uploadToProvider(
		"provider",
		new File(["pdf"], "provider.pdf", { type: "application/pdf" }),
		undefined,
		{ signal: controller.signal },
	);

	expect(fetch).toHaveBeenCalledOnce();
	expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
});

it("does not start an upload with an already-aborted signal", async () => {
	const controller = new AbortController();
	controller.abort();
	const fetch = vi.spyOn(globalThis, "fetch");

	await expect(
		uploadMedia(new File(["pdf"], "aborted.pdf", { type: "application/pdf" }), {
			signal: controller.signal,
		}),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(fetch).not.toHaveBeenCalled();
});

it("aborts image probing when cancellation races object URL creation", async () => {
	const controller = new AbortController();
	let failPendingImage: (() => void) | undefined;
	class PendingImage {
		naturalWidth = 0;
		naturalHeight = 0;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		src = "";

		constructor() {
			failPendingImage = () => this.onerror?.();
		}
	}
	vi.stubGlobal("Image", PendingImage);
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
		controller.abort();
		return "blob:pending-image";
	});
	const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === "/_emdash/api/media/upload-url") return new Response(null, { status: 501 });
		if (url === "/_emdash/api/media") {
			return mediaItemResponse("image-media", "image.png", "image/png");
		}
		return new Response(null, { status: 500 });
	});
	const upload = uploadMedia(new File(["png"], "image.png", { type: "image/png" }), {
		signal: controller.signal,
	});

	try {
		const outcome = await Promise.race([
			upload.then(
				() => "resolved",
				(error: unknown) => (error instanceof DOMException ? error.name : "rejected"),
			),
			new Promise<string>((resolve) => setTimeout(resolve, 50, "timeout")),
		]);
		expect(outcome).toBe("AbortError");
		expect(revokeObjectUrl).toHaveBeenCalledWith("blob:pending-image");
		expect(fetch).toHaveBeenCalledOnce();
	} finally {
		failPendingImage?.();
		await upload.catch(() => undefined);
	}
});
