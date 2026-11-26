import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMediaRegisterUpload } from "../../../src/api/handlers/media.js";
import { POST as postConfirm } from "../../../src/astro/routes/api/media/[id]/confirm.js";
import { POST as postUploadUrl } from "../../../src/astro/routes/api/media/upload-url.js";
import { runSystemCleanup } from "../../../src/cleanup.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import type { SignedUploadOptions } from "../../../src/storage/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";

const reviewed = new Uint8Array([1, 2, 3]);
const swapped = new Uint8Array([4, 5, 6]);

/**
 * A bucket whose signed URL, like an S3 presigned PUT, writes its key any
 * number of times until it expires. `put` is an upload through that URL.
 */
function signedUrlStorage(): MemoryStorage & { put(key: string, body: Uint8Array): void } {
	const storage = createMemoryStorage();
	return Object.assign(storage, {
		async getSignedUploadUrl(options: SignedUploadOptions) {
			return {
				url: `https://bucket.example.com/${options.key}?signature=x`,
				method: "PUT" as const,
				headers: { "Content-Type": options.contentType },
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			};
		},
		put(key: string, body: Uint8Array) {
			storage.files.set(key, { body, contentType: "application/pdf", lastModified: new Date() });
		},
	});
}

describe("confirming a signed upload", () => {
	let db: Kysely<Database>;
	let repo: MediaRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new MediaRepository(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	function context(storage: unknown, path: string, body: unknown, id?: string): APIContext {
		const request = new Request(`http://localhost/_emdash/api/media/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify(body),
		});
		return {
			params: id ? { id } : {},
			url: new URL(request.url),
			request,
			locals: {
				emdash: { db, config: {}, storage },
				user: { id: "user-1", email: "c@example.com", name: "Contributor", role: 20 },
			},
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
		} as unknown as APIContext;
	}

	async function requestUploadUrl(storage: unknown) {
		const response = await postUploadUrl(
			context(storage, "upload-url", {
				filename: "a.pdf",
				contentType: "application/pdf",
				size: reviewed.byteLength,
			}),
		);
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { mediaId: string; storageKey: string } };
		return data;
	}

	it("makes the item ready under a key the signed URL cannot write", async () => {
		const storage = signedUrlStorage();
		const target = await requestUploadUrl(storage);
		storage.put(target.storageKey, reviewed);

		const response = await postConfirm(
			context(storage, `${target.mediaId}/confirm`, {}, target.mediaId),
		);
		expect(response.status).toBe(200);
		const { item } = ((await response.json()) as { data: { item: { storageKey: string } } }).data;
		expect(item.storageKey).not.toBe(target.storageKey);
		expect(storage.files.has(target.storageKey)).toBe(false);

		// The signed URL is used a second time.
		storage.put(target.storageKey, swapped);

		expect(storage.files.get(item.storageKey)?.body).toEqual(reviewed);
		expect(await repo.findById(target.mediaId)).toMatchObject({
			status: "ready",
			storageKey: item.storageKey,
			contentHash: await computeContentHash(reviewed),
		});

		// What the URL stored afterwards goes once the URL has expired.
		await runSystemCleanup(db, storage);
		expect(storage.files.has(target.storageKey)).toBe(true);
		await db
			.updateTable("_emdash_media_upload_attempts")
			.set({ created_at: new Date(Date.now() - 2 * 3600_000).toISOString() })
			.where("storage_key", "=", target.storageKey)
			.execute();
		await runSystemCleanup(db, storage);
		expect(storage.files.has(target.storageKey)).toBe(false);
		expect(storage.files.get(item.storageKey)?.body).toEqual(reviewed);
	});

	it("copies inside the storage service when the adapter can", async () => {
		const storage = signedUrlStorage();
		const copy = vi.fn(async (options: { sourceKey: string; key: string; contentType: string }) => {
			storage.put(options.key, storage.files.get(options.sourceKey)!.body);
		});
		const download = vi.spyOn(storage, "download");
		const upload = vi.spyOn(storage, "upload");
		const target = await requestUploadUrl(storage);
		storage.put(target.storageKey, reviewed);

		const response = await postConfirm(
			context({ ...storage, copy }, `${target.mediaId}/confirm`, {}, target.mediaId),
		);

		expect(response.status).toBe(200);
		const ready = await repo.findById(target.mediaId);
		expect(copy).toHaveBeenCalledExactlyOnceWith({
			sourceKey: target.storageKey,
			key: ready?.storageKey,
			contentType: "application/pdf",
		});
		expect(upload).not.toHaveBeenCalled();
		expect(download).toHaveBeenCalledExactlyOnceWith(ready?.storageKey);
	});

	it("leaves the pending upload in place when the stored size is wrong", async () => {
		const storage = signedUrlStorage();
		const target = await requestUploadUrl(storage);
		storage.put(target.storageKey, new Uint8Array([1, 2]));

		const response = await postConfirm(
			context(storage, `${target.mediaId}/confirm`, {}, target.mediaId),
		);

		expect(response.status).toBe(400);
		expect(await repo.findById(target.mediaId)).toMatchObject({
			status: "pending",
			storageKey: target.storageKey,
		});
		expect([...storage.files.keys()]).toEqual([target.storageKey]);
	});

	it("registers a signed upload under a key the signed URL cannot write", async () => {
		const storage = signedUrlStorage();
		const target = await requestUploadUrl(storage);
		storage.put(target.storageKey, reviewed);

		const result = await handleMediaRegisterUpload(db, storage, {
			storageKey: target.storageKey,
			authorId: "user-1",
		});
		if (!result.success) throw new Error(result.error.message);
		const { item } = result.data;
		expect(item.storageKey).not.toBe(target.storageKey);

		storage.put(target.storageKey, swapped);

		expect(storage.files.get(item.storageKey)?.body).toEqual(reviewed);
		expect(await repo.findById(target.mediaId)).toMatchObject({
			status: "ready",
			storageKey: item.storageKey,
		});
		expect(await repo.hasUploadAttempt(target.storageKey)).toBe(true);
	});

	it("keeps the signed key's object while another media item still uses it", async () => {
		const storage = signedUrlStorage();
		const target = await requestUploadUrl(storage);
		storage.put(target.storageKey, reviewed);
		// A legacy duplicate registration of the same object.
		await repo.create({
			filename: "legacy.pdf",
			mimeType: "application/pdf",
			storageKey: target.storageKey,
		});

		const response = await postConfirm(
			context(storage, `${target.mediaId}/confirm`, {}, target.mediaId),
		);

		expect(response.status).toBe(200);
		expect((await repo.findById(target.mediaId))?.storageKey).not.toBe(target.storageKey);
		expect(storage.files.get(target.storageKey)?.body).toEqual(reviewed);
	});
});
