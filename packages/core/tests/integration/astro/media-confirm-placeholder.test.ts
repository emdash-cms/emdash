import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postConfirm } from "../../../src/astro/routes/api/media/[id]/confirm.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import { JPEG_4x4, PNG_4x4 } from "../../utils/image-fixtures.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("jpeg-js", { spy: true });

/** Storage stub matching the real interface: download returns a ReadableStream. */
function storageWith(bytes: Uint8Array) {
	return {
		async exists() {
			return true;
		},
		async download() {
			return {
				body: new Response(bytes).body as ReadableStream<Uint8Array>,
				contentType: "image/jpeg",
				size: bytes.byteLength,
			};
		},
	};
}

/** Storage stub whose download is spyable (to assert read-back never happens). */
function spyableStorage(bytes: Uint8Array, reportedSize = bytes.byteLength) {
	const download = vi.fn(async () => ({
		body: new Response(bytes).body as ReadableStream<Uint8Array>,
		contentType: "image/jpeg",
		size: reportedSize,
	}));
	return {
		exists: vi.fn(async () => true),
		download,
	};
}

function buildContext(opts: {
	db: Kysely<Database>;
	id: string;
	storage: unknown;
	body: Record<string, unknown>;
	role?: 20 | 50;
	imagePlaceholders?: boolean;
}): APIContext {
	const request = new Request(`http://localhost/_emdash/api/media/${opts.id}/confirm`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(opts.body),
	});
	return {
		params: { id: opts.id },
		url: new URL(request.url),
		request,
		locals: {
			emdash: {
				db: opts.db,
				storage: opts.storage,
				config: { imagePlaceholders: opts.imagePlaceholders },
			},
			user: { id: "user-1", email: "t@example.com", name: "T", role: opts.role ?? 50 },
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

describe("POST /media/:id/confirm — placeholder read-back", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("computes blurhash and dominantColor from the stored image on confirm", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo.jpg",
			authorId: "user-1",
		});

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: storageWith(JPEG_4x4),
				body: { size: JPEG_4x4.byteLength, width: 4, height: 4 },
			}),
		);

		expect(res.status).toBe(200);
		const row = await repo.findById(pending.id);
		expect(row?.status).toBe("ready");
		expect(row?.width).toBe(4);
		expect(row?.blurhash).toBeTruthy();
		expect(row?.dominantColor).toMatch(/^rgb\(/);
		expect(row?.contentHash).toBe(await computeContentHash(JPEG_4x4));
	});

	it("allows a contributing uploader to confirm their own pending file", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "document.pdf",
			mimeType: "application/pdf",
			size: 3,
			storageKey: "document.pdf",
			authorId: "user-1",
		});

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: {
					async exists() {
						return true;
					},
					async download() {
						return {
							body: new Response(new Uint8Array([1, 2, 3])).body as ReadableStream<Uint8Array>,
							contentType: "application/pdf",
							size: 3,
						};
					},
				},
				body: { size: 3 },
				role: 20,
			}),
		);

		expect(res.status).toBe(200);
		expect(await repo.findById(pending.id)).toMatchObject({ status: "ready" });
	});

	it("cancels a stored download whose bytes exceed its reported size", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "document.pdf",
			mimeType: "application/pdf",
			size: 1,
			storageKey: "document.pdf",
			authorId: "user-1",
		});
		const cancel = vi.fn();
		const storage = {
			async exists() {
				return true;
			},
			async download() {
				return {
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2]));
						},
						cancel,
					}),
					contentType: "application/pdf",
					size: 1,
				};
			},
		};

		const res = await postConfirm(buildContext({ db, id: pending.id, storage, body: { size: 1 } }));

		expect(res.status).toBe(500);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("does not re-read a proxied non-image after the server hashed it", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "document.pdf",
			mimeType: "application/pdf",
			size: 3,
			storageKey: "document.attempt.pdf",
			contentHash: "sha1:7037807198c22a7d2b0807371d763779a84fdfcf",
			authorId: "user-1",
		});
		await repo.createUploadAttempt(pending.id, pending.storageKey);
		let bodyRead = false;
		const cancel = vi.fn(async () => undefined);
		const storage = {
			async exists() {
				return true;
			},
			async download() {
				return {
					body: {
						getReader() {
							bodyRead = true;
							throw new Error("Body should not be read");
						},
						cancel,
					},
					contentType: "application/pdf",
					size: 3,
				};
			},
		};

		const res = await postConfirm(
			buildContext({ db, id: pending.id, storage, body: { size: 3 }, role: 20 }),
		);

		expect(res.status).toBe(200);
		expect(bodyRead).toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("rejects a client size that disagrees with the pending upload", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			size: JPEG_4x4.byteLength,
			storageKey: "photo.jpg",
			authorId: "user-1",
		});
		const storage = spyableStorage(JPEG_4x4);

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage,
				body: { size: 1 },
				role: 20,
			}),
		);

		expect(res.status).toBe(400);
		expect(storage.download).not.toHaveBeenCalled();
		expect(await repo.findById(pending.id)).toMatchObject({
			status: "pending",
			size: JPEG_4x4.byteLength,
		});
	});

	it("skips placeholder read-back for oversized images (OOM guard) but still confirms", async () => {
		const repo = new MediaRepository(db);
		const reportedSize = 64 * 1024 * 1024;
		const pending = await repo.createPending({
			filename: "huge.jpg",
			mimeType: "image/jpeg",
			size: reportedSize,
			storageKey: "huge.jpg",
			contentHash: "sha1:a9993e364706816aba3e25717850c26c9cd0d89d",
			authorId: "user-1",
		});
		await repo.createUploadAttempt(pending.id, pending.storageKey);
		const storage = spyableStorage(JPEG_4x4, reportedSize);

		// Confirm claims a size far above the download cap. The signed-URL flow
		// exists so large files bypass server buffering; confirm must not re-read
		// such an object into memory just to compute a blurhash.
		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage,
				body: { size: reportedSize, width: 4000, height: 3000 },
			}),
		);

		expect(res.status).toBe(200);
		expect(storage.download).toHaveBeenCalledOnce();
		const row = await repo.findById(pending.id);
		expect(row?.status).toBe("ready");
		// Client-supplied dimensions are still recorded even when LQIP is skipped.
		expect(row?.width).toBe(4000);
		expect(row?.height).toBe(3000);
		expect(row?.blurhash).toBeNull();
		expect(row?.dominantColor).toBeNull();
	});

	it("does not read back an oversized signed upload to compute a hash", async () => {
		const repo = new MediaRepository(db);
		const reportedSize = 64 * 1024 * 1024;
		const pending = await repo.createPending({
			filename: "signed-huge.jpg",
			mimeType: "image/jpeg",
			size: reportedSize,
			storageKey: "signed-huge.jpg",
			authorId: "user-1",
		});
		const storage = spyableStorage(JPEG_4x4, reportedSize);

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage,
				body: { size: reportedSize, width: 4000, height: 3000 },
			}),
		);

		expect(res.status).toBe(200);
		expect(await repo.findById(pending.id)).toMatchObject({
			status: "ready",
			contentHash: null,
		});
	});

	it("uses a supplied thumbnail without decoding the original and preserves its dimensions and hash", async () => {
		const repo = new MediaRepository(db);
		const jpeg = await import("jpeg-js");
		const width = 2333;
		const height = 3500;
		const original = new Uint8Array(
			jpeg.encode(
				{
					data: Buffer.alloc(width * height * 4, 0xff),
					width,
					height,
				},
				50,
			).data,
		);
		const decodeOriginal = vi.mocked(jpeg.decode);
		decodeOriginal.mockClear();
		const pending = await repo.createPending({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			size: original.byteLength,
			storageKey: "photo.jpg",
			authorId: "user-1",
		});
		const thumbnail = Buffer.from(PNG_4x4).toString("base64");

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: storageWith(original),
				body: {
					size: original.byteLength,
					width,
					height,
					thumbnail: { contentType: "image/png", data: thumbnail },
				},
			}),
		);

		expect(res.status).toBe(200);
		expect(await repo.findById(pending.id)).toMatchObject({
			status: "ready",
			width,
			height,
			blurhash: expect.any(String),
			dominantColor: "rgb(255,0,0)",
			contentHash: await computeContentHash(original),
		});
		expect(decodeOriginal).not.toHaveBeenCalled();
	});

	it("accepts a 64px thumbnail without replacing original dimensions or hashing thumbnail bytes", async () => {
		const { encode } = await import("jpeg-js");
		const thumbnail = encode(
			{ data: Buffer.alloc(64 * 64 * 4, 0xff), width: 64, height: 64 },
			50,
		).data;
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo.jpg",
			authorId: "user-1",
		});
		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: storageWith(JPEG_4x4),
				body: {
					thumbnail: { contentType: "image/jpeg", data: Buffer.from(thumbnail).toString("base64") },
				},
			}),
		);

		expect(res.status).toBe(200);
		expect(await repo.findById(pending.id)).toMatchObject({
			width: 4,
			height: 4,
			dominantColor: "rgb(255,255,255)",
			contentHash: await computeContentHash(JPEG_4x4),
		});
	});

	it.each([true, false])(
		"uses a thumbnail for an oversized original without reading its body (dimensions supplied: %s)",
		async (supplyDimensions) => {
			const repo = new MediaRepository(db);
			const reportedSize = 8 * 1024 * 1024 + 1;
			const pending = await repo.createPending({
				filename: "large.jpg",
				mimeType: "image/jpeg",
				size: reportedSize,
				storageKey: "large.jpg",
				authorId: "user-1",
			});
			const getReader = vi.fn(() => {
				throw new Error("large original body must not be read");
			});
			const cancel = vi.fn(async () => undefined);
			const storage = {
				exists: vi.fn(async () => true),
				download: vi.fn(async () => ({
					body: { getReader, cancel },
					contentType: "image/jpeg",
					size: reportedSize,
				})),
			};

			const res = await postConfirm(
				buildContext({
					db,
					id: pending.id,
					storage,
					body: {
						size: reportedSize,
						...(supplyDimensions ? { width: 4000, height: 3000 } : {}),
						thumbnail: { contentType: "image/png", data: Buffer.from(PNG_4x4).toString("base64") },
					},
				}),
			);

			expect(res.status).toBe(200);
			expect(getReader).not.toHaveBeenCalled();
			expect(cancel).toHaveBeenCalledOnce();
			expect(await repo.findById(pending.id)).toMatchObject({
				status: "ready",
				width: supplyDimensions ? 4000 : null,
				height: supplyDimensions ? 3000 : null,
				blurhash: expect.any(String),
			});
		},
	);

	it("does not decode thumbnails when placeholders are disabled", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "disabled.jpg",
			mimeType: "image/jpeg",
			size: JPEG_4x4.byteLength,
			storageKey: "disabled.jpg",
			authorId: "user-1",
		});
		const decodeError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: storageWith(JPEG_4x4),
				imagePlaceholders: false,
				body: {
					size: JPEG_4x4.byteLength,
					width: 4,
					height: 4,
					thumbnail: { contentType: "image/png", data: "not-base64" },
				},
			}),
		);

		expect(res.status).toBe(200);
		expect(decodeError).not.toHaveBeenCalledWith(
			expect.stringContaining("thumbnail decode failed:"),
			expect.anything(),
		);
		expect(await repo.findById(pending.id)).toMatchObject({
			status: "ready",
			width: 4,
			height: 4,
			blurhash: null,
			dominantColor: null,
			contentHash: await computeContentHash(JPEG_4x4),
		});
	});

	it.each([
		["image/png", "a".repeat(32_769)],
		["image/gif", Buffer.from(PNG_4x4).toString("base64")],
	] as const)("rejects invalid confirm thumbnail %s", async (contentType, data) => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "invalid-thumbnail.jpg",
			mimeType: "image/jpeg",
			size: JPEG_4x4.byteLength,
			storageKey: "invalid-thumbnail.jpg",
			authorId: "user-1",
		});

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: storageWith(JPEG_4x4),
				body: { size: JPEG_4x4.byteLength, thumbnail: { contentType, data } },
			}),
		);

		expect(res.status).toBe(400);
		expect(await repo.findById(pending.id)).toMatchObject({ status: "pending" });
	});

	it("omits a placeholder for oversized or corrupt thumbnails without decoding the original", async () => {
		const repo = new MediaRepository(db);
		const { encode } = await import("jpeg-js");
		const oversizedThumbnail = encode(
			{ data: Buffer.alloc(65 * 65 * 4, 0xff), width: 65, height: 65 },
			50,
		).data;
		const cases = [
			Buffer.from(oversizedThumbnail).toString("base64"),
			"%%%not-base64%%",
			Buffer.from([1, 2, 3]).toString("base64"),
		];
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		for (const [index, data] of cases.entries()) {
			const pending = await repo.createPending({
				filename: `bad-thumbnail-${index}.jpg`,
				mimeType: "image/jpeg",
				size: JPEG_4x4.byteLength,
				storageKey: `bad-thumbnail-${index}.jpg`,
				authorId: "user-1",
			});
			const res = await postConfirm(
				buildContext({
					db,
					id: pending.id,
					storage: storageWith(JPEG_4x4),
					body: {
						size: JPEG_4x4.byteLength,
						width: 1,
						height: 1,
						thumbnail: { contentType: "image/jpeg", data },
					},
				}),
			);

			expect(res.status).toBe(200);
			expect(await repo.findById(pending.id)).toMatchObject({
				status: "ready",
				width: 1,
				height: 1,
				blurhash: null,
				dominantColor: null,
			});
		}
	});

	it("reports invalid state when another request resolves the pending upload first", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "document.pdf",
			mimeType: "application/pdf",
			size: 3,
			storageKey: "document.pdf",
			authorId: "user-1",
		});

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: {
					async exists() {
						return true;
					},
					async download() {
						await db
							.updateTable("media")
							.set({ status: "failed" })
							.where("id", "=", pending.id)
							.execute();
						return {
							body: new Response(new Uint8Array([1, 2, 3])).body as ReadableStream<Uint8Array>,
							contentType: "application/pdf",
							size: 3,
						};
					},
				},
				body: { size: 3 },
			}),
		);

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: { code: "INVALID_STATE" },
		});
		expect(await repo.findById(pending.id)).toMatchObject({ status: "failed" });
	});

	it("reports not found when pending cleanup deletes the row first", async () => {
		const repo = new MediaRepository(db);
		const pending = await repo.createPending({
			filename: "document.pdf",
			mimeType: "application/pdf",
			size: 3,
			storageKey: "document.pdf",
			authorId: "user-1",
		});

		const res = await postConfirm(
			buildContext({
				db,
				id: pending.id,
				storage: {
					async exists() {
						return true;
					},
					async download() {
						await db.deleteFrom("media").where("id", "=", pending.id).execute();
						return {
							body: new Response(new Uint8Array([1, 2, 3])).body as ReadableStream<Uint8Array>,
							contentType: "application/pdf",
							size: 3,
						};
					},
				},
				body: { size: 3 },
			}),
		);

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toMatchObject({
			error: { code: "NOT_FOUND" },
		});
	});
});
