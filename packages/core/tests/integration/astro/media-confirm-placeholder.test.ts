import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postConfirm } from "../../../src/astro/routes/api/media/[id]/confirm.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { JPEG_4x4 } from "../../utils/image-fixtures.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

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
			emdash: { db: opts.db, storage: opts.storage },
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
			authorId: "user-1",
		});
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
