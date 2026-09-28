import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageCollectionDeletionRepository } from "../../../src/media/usage/collection-deletion.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage collection deletion operator repository", (dialect) => {
	let ctx: DialectTestContext;
	let repository: MediaUsageCollectionDeletionRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repository = new MediaUsageCollectionDeletionRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("returns a bounded redacted failed page with an opaque cursor", async () => {
		await insert("failed-a", "failed_a", "failed", "lease-a");
		await insert("failed-b", "failed_b", "failed", "lease-b");

		const first = await repository.findOperatorPage({ state: "failed", limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).toBeDefined();
		expect(first.items[0]).not.toHaveProperty("leaseToken");
		const second = await repository.findOperatorPage({
			state: "failed",
			limit: 1,
			cursor: first.nextCursor,
		});
		expect(second.items).toHaveLength(1);
		expect(second.items[0]?.collectionId).not.toBe(first.items[0]?.collectionId);
	});

	it("reopens failed, retry, and expired exact work but preserves a live lease", async () => {
		await insert("failed-id", "failed", "failed", null);
		await insert("retry-id", "retry", "retry", null);
		await insert("expired-id", "expired", "leased", "expired-token", "2000-01-01T00:00:00.000Z");
		await insert("live-id", "live", "leased", "private-live-token", "2999-01-01T00:00:00.000Z");

		for (const collectionId of ["failed-id", "retry-id", "expired-id"]) {
			const result = await repository.retryOperatorDeletion({ collectionId });
			expect(result).toEqual(
				expect.objectContaining({ outcome: "pending", changed: true, item: expect.any(Object) }),
			);
			expect(result).not.toHaveProperty("leaseToken");
		}
		expect(await repository.retryOperatorDeletion({ collectionId: "live-id" })).toEqual({
			outcome: "lease_active",
			leaseExpiresAt: "2999-01-01T00:00:00.000Z",
		});
		expect(await repository.retryOperatorDeletion({ collectionId: "missing" })).toEqual({
			outcome: "not_found",
		});
	});

	async function insert(
		collectionId: string,
		slug: string,
		state: "failed" | "retry" | "leased",
		leaseToken: string | null,
		leaseExpiresAt: string | null = null,
	) {
		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: collectionId,
				collection_slug: slug,
				force_delete: 1,
				state,
				phase: "work",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
				lease_token: leaseToken,
				lease_expires_at: leaseExpiresAt,
				last_error_code: "MEDIA_USAGE_COLLECTION_DELETION_FAILED",
			})
			.execute();
	}
});
