import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSystemCleanup } from "../../../src/cleanup.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

describe("local media provider deletion", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("queues a failed storage deletion for cleanup", async () => {
		const repo = new MediaRepository(db);
		const item = await repo.create({
			filename: "photo.png",
			mimeType: "image/png",
			storageKey: "media/photo.png",
		});
		const remove = vi.fn().mockRejectedValueOnce(new Error("storage unavailable"));
		const storage = { delete: remove } as unknown as Storage;
		const provider = createMediaProvider({ db, storage });

		await provider.delete(item.id);

		expect(await repo.findById(item.id)).toBeNull();
		expect(await repo.hasUploadAttempt(item.storageKey)).toBe(true);
		remove.mockResolvedValueOnce(undefined);
		await runSystemCleanup(db, storage);
		expect(await repo.hasUploadAttempt(item.storageKey)).toBe(false);
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it("rejects when a database write fails during deletion", async () => {
		const repo = new MediaRepository(db);
		const item = await repo.create({
			filename: "photo.png",
			mimeType: "image/png",
			storageKey: "media/photo.png",
		});
		await db.schema.dropTable("_emdash_media_upload_attempts").execute();
		const storage = { delete: vi.fn() } as unknown as Storage;
		const provider = createMediaProvider({ db, storage });

		await expect(provider.delete(item.id)).rejects.toThrow("Failed to delete media");
		expect(await repo.findById(item.id)).not.toBeNull();
		expect(storage.delete).not.toHaveBeenCalled();
	});

	it("resolves for an unknown id", async () => {
		const storage = { delete: vi.fn() } as unknown as Storage;
		const provider = createMediaProvider({ db, storage });

		await expect(provider.delete("missing")).resolves.toBeUndefined();
		expect(storage.delete).not.toHaveBeenCalled();
	});
});
