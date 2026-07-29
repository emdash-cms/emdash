import { afterEach, expect, it, vi } from "vitest";

import { uploadMedia } from "../../src/lib/api/media.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("deduplicates uploads using the file content hash", async () => {
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

	const item = await uploadMedia(file);

	expect(uploadUrlBody?.contentHash).toBe("sha1:a9993e364706816aba3e25717850c26c9cd0d89d");
	expect(item.id).toBe("existing-media");
	expect(fetch).toHaveBeenCalledTimes(2);
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
