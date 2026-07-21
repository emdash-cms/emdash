/**
 * Tests for the programmatic media upload handler backing the
 * `media_upload` MCP tool (#620).
 *
 * Covers base64 and URL modes, input validation, the global MIME
 * allowlist, size limits, SSRF rejection, and content-hash dedupe.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMediaUpload } from "../../../../src/api/handlers/media-upload.js";
import type { Database } from "../../../../src/database/types.js";
import { setDefaultDnsResolver } from "../../../../src/security/ssrf.js";
import type { Storage } from "../../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../../utils/test-db.js";

// 1x1 transparent PNG
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

function createFakeStorage() {
	const uploads = new Map<string, Uint8Array>();
	const storage = {
		uploads,
		async upload(options: { key: string; body: Uint8Array; contentType: string }) {
			uploads.set(options.key, options.body);
			return { key: options.key, url: `/${options.key}`, size: options.body.byteLength };
		},
		async download(): Promise<never> {
			throw new Error("not implemented");
		},
		async delete(key: string) {
			uploads.delete(key);
		},
		async exists(key: string) {
			return uploads.has(key);
		},
		async list() {
			return { items: [] };
		},
		async getSignedUploadUrl(): Promise<never> {
			throw new Error("not implemented");
		},
	};
	// ponytail: structural stand-in covers the Storage surface this handler uses
	return storage as unknown as Storage & { uploads: Map<string, Uint8Array> };
}

describe("handleMediaUpload (#620)", () => {
	let db: Kysely<Database>;
	let storage: ReturnType<typeof createFakeStorage>;
	let previousResolver: ReturnType<typeof setDefaultDnsResolver>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		storage = createFakeStorage();
		// Resolve every hostname to a public IP so ssrfSafeFetch doesn't hit DNS
		previousResolver = setDefaultDnsResolver(async () => ["93.184.216.34"]);
	});

	afterEach(async () => {
		setDefaultDnsResolver(previousResolver ?? null);
		vi.unstubAllGlobals();
		await teardownTestDatabase(db);
	});

	it("uploads base64 data and creates a media record", async () => {
		const result = await handleMediaUpload(db, storage, {
			filename: "pixel.png",
			base64: PNG_BASE64,
			contentType: "image/png",
			alt: "a pixel",
			authorId: "user_1",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		const { item } = result.data;
		expect(item.filename).toBe("pixel.png");
		expect(item.mimeType).toBe("image/png");
		expect(item.alt).toBe("a pixel");
		expect(item.authorId).toBe("user_1");
		expect(item.width).toBe(1);
		expect(item.height).toBe(1);
		expect(item.storageKey).toMatch(/\.png$/);
		expect(item.url).toBe(`/_emdash/api/media/file/${item.storageKey}`);
		expect(storage.uploads.get(item.storageKey)).toEqual(PNG_BYTES);
	});

	it("deduplicates identical bytes by content hash", async () => {
		const first = await handleMediaUpload(db, storage, {
			filename: "a.png",
			base64: PNG_BASE64,
			contentType: "image/png",
		});
		const second = await handleMediaUpload(db, storage, {
			filename: "b.png",
			base64: PNG_BASE64,
			contentType: "image/png",
		});

		expect(first.success && second.success).toBe(true);
		if (!first.success || !second.success) return;
		expect(second.data.deduplicated).toBe(true);
		expect(second.data.item.id).toBe(first.data.item.id);
		expect(storage.uploads.size).toBe(1);
	});

	it("rejects when neither or both of base64/url are provided", async () => {
		const neither = await handleMediaUpload(db, storage, { filename: "x.png" });
		const both = await handleMediaUpload(db, storage, {
			filename: "x.png",
			base64: PNG_BASE64,
			url: "https://example.com/x.png",
			contentType: "image/png",
		});
		for (const result of [neither, both]) {
			expect(result.success).toBe(false);
			if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
		}
	});

	it("requires contentType with base64 data", async () => {
		const result = await handleMediaUpload(db, storage, {
			filename: "x.png",
			base64: PNG_BASE64,
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects invalid base64 data", async () => {
		const result = await handleMediaUpload(db, storage, {
			filename: "x.png",
			base64: "!!!not-base64!!!",
			contentType: "image/png",
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects malformed MIME strings that would pass the prefix allowlist", async () => {
		// "image/png\r\nX-Evil: 1" starts with "image/" but must never reach
		// the storage ContentType header or the file-serving response.
		const crafted = await handleMediaUpload(db, storage, {
			filename: "x.png",
			base64: PNG_BASE64,
			contentType: "image/png\r\nX-Evil: 1",
		});
		expect(crafted.success).toBe(false);
		if (!crafted.success) expect(crafted.error.code).toBe("VALIDATION_ERROR");
		expect(storage.uploads.size).toBe(0);
	});

	it("rejects a malformed Content-Type header from a remote host", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const response = new Response(PNG_BYTES);
				// Response normalizes header values, so inject the raw string
				vi.spyOn(response.headers, "get").mockReturnValue("image/png\r\nX-Evil: 1");
				return response;
			}),
		);

		const result = await handleMediaUpload(db, storage, {
			filename: "remote.png",
			url: "https://example.com/remote.png",
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(storage.uploads.size).toBe(0);
	});

	it("rejects MIME types outside the global allowlist", async () => {
		const result = await handleMediaUpload(db, storage, {
			filename: "evil.exe",
			base64: PNG_BASE64,
			contentType: "application/x-msdownload",
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("INVALID_TYPE");
		expect(storage.uploads.size).toBe(0);
	});

	it("rejects payloads over the size limit", async () => {
		const result = await handleMediaUpload(db, storage, {
			filename: "big.png",
			base64: PNG_BASE64,
			contentType: "image/png",
			maxUploadSize: 8,
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	it("fetches from a URL, using the response Content-Type", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } })),
		);

		const result = await handleMediaUpload(db, storage, {
			filename: "remote.png",
			url: "https://example.com/remote.png",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.mimeType).toBe("image/png");
		expect(storage.uploads.get(result.data.item.storageKey)).toEqual(PNG_BYTES);
	});

	it("surfaces HTTP errors from the remote host", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 404 })),
		);

		const result = await handleMediaUpload(db, storage, {
			filename: "missing.png",
			url: "https://example.com/missing.png",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("FETCH_ERROR");
			expect(result.error.message).toContain("404");
		}
	});

	it("rejects URLs that resolve to private addresses (SSRF)", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await handleMediaUpload(db, storage, {
			filename: "metadata.json",
			url: "http://169.254.169.254/latest/meta-data",
		});
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
