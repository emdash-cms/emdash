import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

describeEachDialect("pending media upload publication", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaRepository(ctx.db as Kysely<Database>);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("allows only one upload attempt to publish its storage key", async () => {
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "pending.png",
		});
		await Promise.all([
			repo.createUploadAttempt(pending.id, "attempt-a.png"),
			repo.createUploadAttempt(pending.id, "attempt-b.png"),
		]);

		const results = await Promise.all([
			repo.publishPendingStorageKey(
				pending.id,
				"pending.png",
				"attempt-a.png",
				"sha1:a9993e364706816aba3e25717850c26c9cd0d89d",
			),
			repo.publishPendingStorageKey(
				pending.id,
				"pending.png",
				"attempt-b.png",
				"sha1:a9993e364706816aba3e25717850c26c9cd0d89d",
			),
		]);

		expect(results).toContain(true);
		expect(results).toContain(false);
		expect((await repo.findById(pending.id))?.storageKey).toMatch(/^attempt-[ab]\.png$/);
	});

	it("does not apply stale confirmation state after the storage key changes", async () => {
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "pending.png",
		});
		await repo.createUploadAttempt(pending.id, "replacement.png");
		await repo.publishPendingStorageKey(
			pending.id,
			pending.storageKey,
			"replacement.png",
			"sha1:589c22335a381f122d129225f5c0ba3056ed5811",
		);

		await expect(
			repo.confirmUpload(pending.id, { width: 100 }, pending.storageKey),
		).resolves.toBeNull();
		await expect(repo.markFailed(pending.id, pending.storageKey)).resolves.toBeNull();
		expect(await repo.findById(pending.id)).toMatchObject({
			status: "pending",
			storageKey: "replacement.png",
			width: null,
		});
	});

	it("does not claim a fresh active attempt for cleanup", async () => {
		const pending = await repo.createPending({
			filename: "photo.png",
			mimeType: "image/png",
			size: 3,
			storageKey: "pending.png",
		});
		await repo.createUploadAttempt(pending.id, "fresh-attempt.png");

		expect(await repo.findUploadAttemptsForCleanup()).not.toContain("fresh-attempt.png");
	});

	it("returns only storage keys deleted by pending cleanup", async () => {
		const expired = await repo.createPending({
			filename: "expired.png",
			mimeType: "image/png",
			storageKey: "expired.png",
		});
		const ready = await repo.create({
			filename: "ready.png",
			mimeType: "image/png",
			storageKey: "ready.png",
			status: "ready",
		});
		await ctx.db
			.updateTable("media")
			.set({ created_at: new Date(0).toISOString() })
			.where("id", "in", [expired.id, ready.id])
			.execute();

		expect(await repo.cleanupPendingUploads()).toEqual([expired.storageKey]);
		expect(await repo.findById(expired.id)).toBeNull();
		expect(await repo.findById(ready.id)).toMatchObject({ status: "ready" });
	});

	it("keeps cleanup and confirmation outcomes consistent under concurrency", async () => {
		for (let i = 0; i < 10; i++) {
			const pending = await repo.createPending({
				filename: `race-${i}.png`,
				mimeType: "image/png",
				storageKey: `race-${i}.png`,
			});
			await ctx.db
				.updateTable("media")
				.set({ created_at: new Date(0).toISOString() })
				.where("id", "=", pending.id)
				.execute();

			const [confirmed, deletedKeys] = await Promise.all([
				repo.confirmUpload(pending.id),
				repo.cleanupPendingUploads(),
			]);
			const stored = await repo.findById(pending.id);

			if (confirmed) {
				expect(stored).toMatchObject({ status: "ready" });
				expect(deletedKeys).not.toContain(pending.storageKey);
			} else {
				expect(stored).toBeNull();
				expect(deletedKeys).toContain(pending.storageKey);
			}
		}
	});
});
