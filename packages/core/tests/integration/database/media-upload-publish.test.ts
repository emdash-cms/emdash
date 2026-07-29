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
			repo.publishPendingStorageKey(pending.id, "pending.png", "attempt-a.png"),
			repo.publishPendingStorageKey(pending.id, "pending.png", "attempt-b.png"),
		]);

		expect(results).toContain(true);
		expect(results).toContain(false);
		expect((await repo.findById(pending.id))?.storageKey).toMatch(/^attempt-[ab]\.png$/);
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
});
