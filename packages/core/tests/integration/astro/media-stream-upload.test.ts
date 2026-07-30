import type { APIContext } from "astro";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMediaDelete, handleMediaGet } from "../../../src/api/handlers/media.js";
import { DELETE as deleteMedia } from "../../../src/astro/routes/api/media/[id].js";
import { POST as postConfirm } from "../../../src/astro/routes/api/media/[id]/confirm.js";
import { PUT as putUpload } from "../../../src/astro/routes/api/media/[id]/upload.js";
import { POST as postUploadUrl } from "../../../src/astro/routes/api/media/upload-url.js";
import { runSystemCleanup } from "../../../src/cleanup.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashStorageError } from "../../../src/storage/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
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

function uploadUrlRequestWithHash(contentHash: string) {
	return new Request("http://localhost/_emdash/api/media/upload-url", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({
			filename: "photo.png",
			contentType: "image/png",
			size: 3,
			contentHash,
		}),
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
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
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

	it("uses a client content hash only as a deduplication probe", async () => {
		const response = await postUploadUrl(
			buildContext({
				db,
				request: uploadUrlRequestWithHash("sha1:a9993e364706816aba3e25717850c26c9cd0d89d"),
				storage: unsupportedSignedUrlStorage(),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { mediaId: string } };
		expect(await new MediaRepository(db).findById(body.data.mediaId)).toMatchObject({
			contentHash: null,
		});
	});

	it("accepts existing client hash formats for deduplication", async () => {
		const repo = new MediaRepository(db);
		const contentHash = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
		const existing = await repo.create({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			contentHash,
		});

		const response = await postUploadUrl(
			buildContext({
				db,
				request: uploadUrlRequestWithHash(contentHash),
				storage: unsupportedSignedUrlStorage(),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { existing?: boolean; mediaId: string } };
		expect(body.data).toMatchObject({ existing: true, mediaId: existing.id });
	});

	it.each([
		{ difference: "MIME type", contentType: "video/mp4", size: 3 },
		{ difference: "size", contentType: "audio/mp4", size: 4 },
	])(
		"does not deduplicate to media with a different $difference",
		async ({ contentType, size }) => {
			const repo = new MediaRepository(db);
			const contentHash = "sha1:a9993e364706816aba3e25717850c26c9cd0d89d";
			const existing = await repo.create({
				filename: "sound.mp4",
				mimeType: "audio/mp4",
				size: 3,
				storageKey: "sound.mp4",
				contentHash,
			});
			const request = new Request("http://localhost/_emdash/api/media/upload-url", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({
					filename: "movie.mp4",
					contentType,
					size,
					contentHash,
				}),
			});

			const response = await postUploadUrl(
				buildContext({ db, request, storage: unsupportedSignedUrlStorage() }),
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				data: { existing?: boolean; mediaId: string };
			};
			expect(body.data.existing).not.toBe(true);
			expect(body.data.mediaId).not.toBe(existing.id);
		},
	);

	it("does not deduplicate an empty file by the shared empty hash", async () => {
		const repo = new MediaRepository(db);
		const existing = await repo.create({
			filename: "legacy-empty.txt",
			mimeType: "text/plain",
			size: 0,
			storageKey: "legacy-empty.txt",
			contentHash: "sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709",
		});
		const request = new Request("http://localhost/_emdash/api/media/upload-url", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({
				filename: "empty.pdf",
				contentType: "application/pdf",
				size: 0,
				contentHash: "sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709",
			}),
		});

		const response = await postUploadUrl(
			buildContext({ db, request, storage: unsupportedSignedUrlStorage() }),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { mediaId: string } };
		expect(body.data.mediaId).not.toBe(existing.id);
		expect(await repo.findById(body.data.mediaId)).toMatchObject({
			filename: "empty.pdf",
			contentHash: null,
		});
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
		expect(uploaded).toMatchObject({
			status: "pending",
			contentHash: "sha1:7037807198c22a7d2b0807371d763779a84fdfcf",
		});
		expect(storage.objects.get(uploaded!.storageKey)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("hashes a fragmented upload across buffer growth", async () => {
		const size = 64 * 1024 + 1;
		const bytes = new Uint8Array(size);
		bytes[size - 1] = 1;
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "fragmented.pdf",
			mimeType: "application/pdf",
			size,
			storageKey: "fragmented.pdf",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, size - 1));
				controller.enqueue(bytes.subarray(size - 1));
				controller.close();
			},
		});
		const request = new Request(`http://localhost/_emdash/api/media/${pending.id}/upload`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/pdf",
				"Content-Length": String(size),
				"X-EmDash-Request": "1",
			},
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const response = await putUpload(
			buildContext({ db, id: pending.id, request, storage, user: { id: "user-1", role: 20 } }),
		);

		expect(response.status).toBe(200);
		expect(await repo.findById(pending.id)).toMatchObject({
			contentHash: await computeContentHash(bytes),
		});
	});

	it("preserves the known body length for Worker storage bindings", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		const fixedLengths = new WeakMap<ReadableStream<Uint8Array>, number>();
		class TestFixedLengthStream {
			readonly readable: ReadableStream<Uint8Array>;
			readonly writable: WritableStream<Uint8Array>;

			constructor(expectedLength: number | bigint) {
				const stream = new TransformStream<Uint8Array, Uint8Array>();
				this.readable = stream.readable;
				this.writable = stream.writable;
				fixedLengths.set(this.readable, Number(expectedLength));
			}
		}
		vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);
		storage.upload.mockImplementationOnce(async (options) => {
			if (fixedLengths.get(options.body) !== 3) {
				throw new TypeError("Provided readable stream must have a known length");
			}
			const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
			storage.objects.set(options.key, bytes);
			return { key: options.key, url: `/media/${options.key}`, size: bytes.byteLength };
		});

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
			}),
		);

		expect(response.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledOnce();
		const uploaded = await repo.findById(pending.id);
		expect(storage.objects.get(uploaded!.storageKey)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("reports a truncated fixed-length upload as a size mismatch", async () => {
		const pending = await new MediaRepository(db).createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		class TestFixedLengthStream {
			readonly readable: ReadableStream<Uint8Array>;
			readonly writable: WritableStream<Uint8Array>;

			constructor(expectedLength: number | bigint) {
				let received = 0;
				const stream = new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						received += chunk.byteLength;
						controller.enqueue(chunk);
					},
					flush(controller) {
						if (received !== Number(expectedLength)) {
							controller.error(new TypeError("Fixed-length stream ended early"));
						}
					},
				});
				this.readable = stream.readable;
				this.writable = stream.writable;
			}
		}
		vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2])),
				storage,
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "UPLOAD_SIZE_MISMATCH" },
		});
	});

	it("accepts an empty file", async () => {
		const pending = await new MediaRepository(db).createPending({
			filename: "empty.pdf",
			mimeType: "application/pdf",
			size: 0,
			storageKey: "empty.pdf",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const request = new Request(`http://localhost/_emdash/api/media/${pending.id}/upload`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/pdf",
				"Content-Length": "0",
				"X-EmDash-Request": "1",
			},
		});
		const response = await putUpload(buildContext({ db, id: pending.id, request, storage }));

		expect(response.status).toBe(200);
		const uploaded = await new MediaRepository(db).findById(pending.id);
		expect(storage.objects.get(uploaded!.storageKey)).toEqual(new Uint8Array());
		expect(uploaded?.contentHash).toBeNull();
	});

	it("does not hash large uploads on the Worker request path", async () => {
		const size = 8 * 1024 * 1024 + 1;
		const pending = await new MediaRepository(db).createPending({
			filename: "large.pdf",
			mimeType: "application/pdf",
			size,
			storageKey: "large.pdf",
			authorId: "user-1",
		});
		const storage = streamingStorage();

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array(size), "application/pdf"),
				storage,
			}),
		);

		expect(response.status).toBe(200);
		expect(await new MediaRepository(db).findById(pending.id)).toMatchObject({
			contentHash: null,
		});
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

	it("preserves a completed object when a retry upload fails", async () => {
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

		expect(retryResponse.status).toBe(500);
		expect(storage.upload).toHaveBeenCalledTimes(2);
		expect(await repo.findById(pending.id)).toMatchObject({ storageKey: completedKey });
		expect(storage.objects.get(completedKey)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("processes different same-size bytes when an upload target is retried", async () => {
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
		const firstUpload = await repo.findById(pending.id);
		expect(firstUpload).not.toBeNull();

		const secondResponse = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([4, 5, 6])),
				storage,
			}),
		);

		expect(secondResponse.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledTimes(2);
		const retried = await repo.findById(pending.id);
		expect(retried?.storageKey).not.toBe(firstUpload!.storageKey);
		expect(storage.objects.get(retried!.storageKey)).toEqual(new Uint8Array([4, 5, 6]));
		expect(storage.objects.has(firstUpload!.storageKey)).toBe(false);
		expect(storage.delete).toHaveBeenCalledOnce();
	});

	it("does not confirm stale metadata after a replacement upload", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "document.pdf",
			mimeType: "application/pdf",
			size: 3,
			storageKey: "document.pdf",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		const firstBytes = new Uint8Array([1, 2, 3]);
		const replacementBytes = new Uint8Array([4, 5, 6]);

		await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, firstBytes, "application/pdf"),
				storage,
			}),
		);

		let markConfirmationReading: () => void = () => undefined;
		const confirmationReading = new Promise<void>((resolve) => {
			markConfirmationReading = resolve;
		});
		let finishConfirmation: () => void = () => undefined;
		const confirmationCanFinish = new Promise<void>((resolve) => {
			finishConfirmation = resolve;
		});
		storage.download.mockImplementationOnce(async (key: string) => {
			const bytes = storage.objects.get(key);
			if (!bytes) throw new EmDashStorageError("File not found", "NOT_FOUND");
			return {
				body: new ReadableStream<Uint8Array>({
					cancel() {
						markConfirmationReading();
						return confirmationCanFinish;
					},
				}),
				contentType: "application/pdf",
				size: bytes.byteLength,
			};
		});

		const confirm = () =>
			postConfirm(
				buildContext({
					db,
					id: pending.id,
					request: new Request(`http://localhost/_emdash/api/media/${pending.id}/confirm`, {
						method: "POST",
						headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
						body: "{}",
					}),
					storage,
				}),
			);
		const staleConfirmation = confirm();
		await confirmationReading;

		await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, replacementBytes, "application/pdf"),
				storage,
			}),
		);
		finishConfirmation();

		expect((await staleConfirmation).status).toBe(409);
		const replacement = await repo.findById(pending.id);
		expect(replacement).toMatchObject({
			status: "pending",
			contentHash: await computeContentHash(replacementBytes),
		});
		expect(storage.objects.get(replacement!.storageKey)).toEqual(replacementBytes);

		expect((await confirm()).status).toBe(200);
		expect(await repo.findById(pending.id)).toMatchObject({
			status: "ready",
			contentHash: await computeContentHash(replacementBytes),
		});
	});

	it("does not mark a replacement upload as failed from a stale storage check", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "document.pdf",
			mimeType: "application/pdf",
			size: 3,
			storageKey: "document.pdf",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		const replacementBytes = new Uint8Array([4, 5, 6]);

		let markStorageChecked: () => void = () => undefined;
		const storageChecked = new Promise<void>((resolve) => {
			markStorageChecked = resolve;
		});
		let finishStorageCheck: () => void = () => undefined;
		const storageCheckCanFinish = new Promise<void>((resolve) => {
			finishStorageCheck = resolve;
		});
		storage.exists.mockImplementationOnce(async () => {
			markStorageChecked();
			await storageCheckCanFinish;
			return false;
		});

		const confirm = () =>
			postConfirm(
				buildContext({
					db,
					id: pending.id,
					request: new Request(`http://localhost/_emdash/api/media/${pending.id}/confirm`, {
						method: "POST",
						headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
						body: "{}",
					}),
					storage,
				}),
			);
		const staleConfirmation = confirm();
		await storageChecked;

		await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, replacementBytes, "application/pdf"),
				storage,
			}),
		);
		finishStorageCheck();

		expect((await staleConfirmation).status).toBe(409);
		expect(await repo.findById(pending.id)).toMatchObject({
			status: "pending",
			contentHash: await computeContentHash(replacementBytes),
		});

		expect((await confirm()).status).toBe(200);
		expect(await repo.findById(pending.id)).toMatchObject({ status: "ready" });
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

	it("rejects a losing concurrent upload when its content differs", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		let uploadsStarted = 0;
		let releaseUploads: (() => void) | undefined;
		const bothUploadsStarted = new Promise<void>((resolve) => {
			releaseUploads = resolve;
		});
		storage.upload.mockImplementation(async (options) => {
			const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
			storage.objects.set(options.key, bytes);
			uploadsStarted++;
			if (uploadsStarted === 2) releaseUploads?.();
			await bothUploadsStarted;
			return { key: options.key, url: `/media/${options.key}`, size: bytes.byteLength };
		});

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
					request: uploadRequest(pending.id, new Uint8Array([4, 5, 6])),
					storage,
				}),
			),
		]);

		const statuses = [firstResponse.status, secondResponse.status];
		expect(statuses.filter((status) => status === 200)).toHaveLength(1);
		expect(statuses.filter((status) => status === 400)).toHaveLength(1);
		expect(storage.delete).toHaveBeenCalledOnce();
		expect(storage.objects.size).toBe(1);
	});

	it("preserves an object when publication commits before reporting an error", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		const publish = MediaRepository.prototype.publishPendingStorageKey;
		vi.spyOn(MediaRepository.prototype, "publishPendingStorageKey").mockImplementationOnce(
			async function (
				this: MediaRepository,
				id: string,
				expectedStorageKey: string,
				storageKey: string,
				contentHash: string,
			) {
				await publish.call(this, id, expectedStorageKey, storageKey, contentHash);
				throw new Error("publication acknowledgement lost");
			},
		);

		const response = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
			}),
		);

		expect(response.status).toBe(200);
		const published = await repo.findById(pending.id);
		expect(published?.storageKey).not.toBe(pending.storageKey);
		expect(storage.objects.get(published!.storageKey)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("retries cleanup for an unreferenced upload attempt", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		storage.delete.mockRejectedValueOnce(new Error("temporary R2 failure"));

		const responses = await Promise.all([
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

		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(storage.objects.size).toBe(2);
		await repo.confirmUpload(pending.id);

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
		await runSystemCleanup(db, storage);

		expect(storage.objects.size).toBe(1);
		const published = await repo.findById(pending.id);
		expect(storage.objects.has(published!.storageKey)).toBe(true);
	});

	it("preserves an object confirmed at the pending-cleanup delete boundary", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "expired.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "expired.png",
			authorId: "user-1",
		});
		await db
			.updateTable("media")
			.set({ created_at: new Date(0).toISOString() })
			.where("id", "=", pending.id)
			.execute();

		const storage = streamingStorage();
		storage.objects.set(pending.storageKey, new Uint8Array([1, 2, 3]));

		await sql`
			CREATE TRIGGER confirm_during_pending_cleanup
			BEFORE DELETE ON media
			WHEN OLD.status = 'pending'
			BEGIN
				UPDATE media SET status = 'ready' WHERE id = OLD.id;
				SELECT RAISE(IGNORE);
			END
		`.execute(db);

		const result = await runSystemCleanup(db, storage);

		expect(result.pendingUploads).toBe(0);
		expect(result.pendingUploadFiles).toBe(0);
		expect(await repo.findById(pending.id)).toMatchObject({ status: "ready" });
		expect(storage.objects.has(pending.storageKey)).toBe(true);
	});

	it("does not keep retrying when the database vetoes a media deletion", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "guarded.png",
			mimeType: "image/png",
			storageKey: "guarded.png",
		});
		await sql`CREATE TABLE delete_guard (attempts integer NOT NULL)`.execute(db);
		await sql`INSERT INTO delete_guard (attempts) VALUES (0)`.execute(db);
		await sql`
			CREATE TRIGGER veto_first_media_deletes
			BEFORE DELETE ON media
			WHEN (SELECT attempts FROM delete_guard) < 4
			BEGIN
				UPDATE delete_guard SET attempts = attempts + 1;
				SELECT RAISE(IGNORE);
			END
		`.execute(db);

		await expect(repo.deleteWithStorageKey(pending.id)).resolves.toBeNull();
		expect(await repo.findById(pending.id)).not.toBeNull();
	});

	it("removes the upload attempt after confirmation and allows confirmation retries", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.attempt.png",
			authorId: "user-1",
		});
		await repo.createUploadAttempt(pending.id, pending.storageKey);
		const storage = streamingStorage();
		storage.objects.set(pending.storageKey, new Uint8Array([1, 2, 3]));
		const confirm = () =>
			postConfirm(
				buildContext({
					db,
					id: pending.id,
					request: new Request(`http://localhost/_emdash/api/media/${pending.id}/confirm`, {
						method: "POST",
						headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
						body: JSON.stringify({ size: 3 }),
					}),
					storage,
				}),
			);

		expect((await confirm()).status).toBe(200);
		expect(await repo.hasUploadAttempt(pending.storageKey)).toBe(false);
		expect((await confirm()).status).toBe(200);
	});

	it("reaps completed upload-attempt bookkeeping without deleting the live object", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.attempt.png",
		});
		await repo.createUploadAttempt(pending.id, pending.storageKey);
		await repo.confirmUpload(pending.id);

		const result = await runSystemCleanup(db);

		expect(result.uploadAttempts).toBe(1);
		expect(await repo.hasUploadAttempt(pending.storageKey)).toBe(false);
		expect(await repo.findById(pending.id)).toMatchObject({ status: "ready" });
	});

	it("does not strand the published object when deletion races an upload", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "photo.png",
			authorId: "user-1",
		});
		const storage = streamingStorage();
		let startDelete: (() => void) | undefined;
		const deleteStarted = new Promise<void>((resolve) => {
			startDelete = resolve;
		});
		let finishDelete: (() => void) | undefined;
		const allowDelete = new Promise<void>((resolve) => {
			finishDelete = resolve;
		});

		const deletion = deleteMedia({
			params: { id: pending.id },
			locals: {
				emdash: {
					db,
					storage,
					handleMediaGet: (id: string) => handleMediaGet(db, id),
					handleMediaDelete: async (id: string) => {
						startDelete?.();
						await allowDelete;
						return handleMediaDelete(db, id);
					},
				},
				user: {
					id: "user-1",
					email: "test@example.com",
					name: "Test User",
					role: 30,
				},
			},
		} as unknown as APIContext);
		await deleteStarted;

		const uploadResponse = await putUpload(
			buildContext({
				db,
				id: pending.id,
				request: uploadRequest(pending.id, new Uint8Array([1, 2, 3])),
				storage,
			}),
		);
		finishDelete?.();
		const deleteResponse = await deletion;

		expect(uploadResponse.status).toBe(200);
		expect(deleteResponse.status).toBe(200);
		expect(await repo.findById(pending.id)).toBeNull();
		expect(storage.objects.size).toBe(0);
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
