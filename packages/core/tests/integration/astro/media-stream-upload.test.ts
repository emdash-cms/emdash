import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT as putUpload } from "../../../src/astro/routes/api/media/[id]/upload.js";
import { POST as postUploadUrl } from "../../../src/astro/routes/api/media/upload-url.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashStorageError } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildContext(options: {
	db: Kysely<Database>;
	request: Request;
	storage: unknown;
	id?: string;
	user?: { id: string; role: 20 | 30 | 40 | 50 };
}): APIContext {
	return {
		params: options.id ? { id: options.id } : {},
		url: new URL(options.request.url),
		request: options.request,
		locals: {
			emdash: { db: options.db, config: {}, storage: options.storage },
			user: {
				id: options.user?.id ?? "user-1",
				email: "test@example.com",
				name: "Test User",
				role: options.user?.role ?? 30,
			},
		},
	} as unknown as APIContext;
}

function uploadUrlRequest() {
	return new Request("http://localhost/_emdash/api/media/upload-url", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({ filename: "photo.png", contentType: "image/png", size: 3 }),
	});
}

function uploadRequest(id: string, bytes: Uint8Array, contentType = "image/png") {
	return new Request(`http://localhost/_emdash/api/media/${id}/upload`, {
		method: "PUT",
		headers: { "Content-Type": contentType, "X-EmDash-Request": "1" },
		body: bytes,
	});
}

function unsupportedSignedUrlStorage() {
	return {
		async getSignedUploadUrl() {
			throw new EmDashStorageError("Signed URLs unavailable", "NOT_SUPPORTED");
		},
	};
}

function streamingStorage() {
	const objects = new Map<string, Uint8Array>();
	const upload = vi.fn(
		async (options: { key: string; body: ReadableStream<Uint8Array>; contentType: string }) => {
			const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
			objects.set(options.key, bytes);
			return { key: options.key, url: `/media/${options.key}`, size: bytes.byteLength };
		},
	);
	const deleteObject = vi.fn(async (key: string) => {
		objects.delete(key);
	});
	const exists = vi.fn(async (key: string) => objects.has(key));
	const download = vi.fn(async (key: string) => {
		const bytes = objects.get(key);
		if (!bytes) throw new EmDashStorageError("File not found", "NOT_FOUND");
		return {
			body: new Response(bytes).body as ReadableStream<Uint8Array>,
			contentType: "image/png",
			size: bytes.byteLength,
		};
	});
	return { objects, upload, delete: deleteObject, exists, download };
}

describe("streamed media upload fallback", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("returns a same-origin upload target when signed URLs are unsupported", async () => {
		const response = await postUploadUrl(
			buildContext({
				db,
				request: uploadUrlRequest(),
				storage: unsupportedSignedUrlStorage(),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: { uploadUrl: string; headers: Record<string, string>; mediaId: string };
		};
		expect(body.data.uploadUrl).toBe(`/_emdash/api/media/${body.data.mediaId}/upload`);
		expect(body.data.headers).toMatchObject({
			"Content-Type": "image/png",
			"X-EmDash-Request": "1",
		});

		const pending = await new MediaRepository(db).findById(body.data.mediaId);
		expect(pending).toMatchObject({ status: "pending", size: 3, authorId: "user-1" });
	});

	it("does not create a pending row when signed URL generation fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const response = await postUploadUrl(
			buildContext({
				db,
				request: uploadUrlRequest(),
				storage: {
					async getSignedUploadUrl() {
						throw new EmDashStorageError("Storage unavailable", "UPLOAD_FAILED");
					},
				},
			}),
		);

		expect(response.status).toBe(500);
		expect(await new MediaRepository(db).findMany({ status: "all" })).toMatchObject({ items: [] });
	});

	it("streams the exact request body to storage and leaves confirmation separate", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
				user: { id: "user-1", role: 20 },
			}),
		);

		expect(response.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledOnce();
		const uploadedBody = storage.upload.mock.calls[0]?.[0].body;
		expect(uploadedBody).toBeInstanceOf(ReadableStream);
		const uploaded = await repo.findById(pending.id);
		expect(uploaded).toMatchObject({ status: "pending" });
		expect(storage.objects.get(uploaded!.storageKey)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("rejects a mismatched MIME type without writing to storage", async () => {
		const pending = await new MediaRepository(db).createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3]), "image/jpeg"),
				storage,
			}),
		);

		expect(response.status).toBe(400);
		expect(storage.upload).not.toHaveBeenCalled();
	});

	it("rejects and removes an upload whose streamed byte count does not match", async () => {
		const pending = await new MediaRepository(db).createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2])),
				storage,
			}),
		);

		expect(response.status).toBe(400);
		expect(storage.delete).toHaveBeenCalledOnce();
		expect(storage.objects.size).toBe(0);
	});

	it("aborts and cleans up a stream that exceeds the expected size", async () => {
		const pending = await new MediaRepository(db).createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 2,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
			}),
		);

		expect(response.status).toBe(413);
		expect(storage.delete).toHaveBeenCalledOnce();
		expect(storage.objects.size).toBe(0);
	});

	it("keeps a completed object when the upload request is retried", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const firstResponse = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
			}),
		);
		expect(firstResponse.status).toBe(200);

		const completed = await repo.findById(pending.id);
		expect(completed).not.toBeNull();
		const completedKey = completed!.storageKey;
		expect(storage.objects.get(completedKey)).toEqual(new Uint8Array([1, 2, 3]));

		storage.upload.mockRejectedValueOnce(
			new EmDashStorageError("Storage unavailable", "UPLOAD_FAILED"),
		);
		const retryResponse = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
			}),
		);

		expect(retryResponse.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledOnce();
		expect(storage.objects.get(completedKey)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("publishes only one object when two uploads race", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const [firstResponse, secondResponse] = await Promise.all([
			putUpload(
				buildContext({
					db,
					id: pending.id,
					request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
					storage,
				}),
			),
			putUpload(
				buildContext({
					db,
					id: pending.id,
					request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
					storage,
				}),
			),
		]);

		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledTimes(2);
		expect(storage.delete).toHaveBeenCalledOnce();
		expect(storage.objects.size).toBe(1);
		const published = await repo.findById(pending.id);
		expect(storage.objects.get(published!.storageKey)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("rejects a non-owner without media:edit_any", async () => {
		const pending = await new MediaRepository(db).createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
				user: { id: "user-2", role: 30 },
			}),
		);

		expect(response.status).toBe(403);
		expect(storage.upload).not.toHaveBeenCalled();
	});
});
