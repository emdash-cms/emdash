import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageWorkRepository } from "../../../src/database/repositories/media-usage-work.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage work repository", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaUsageWorkRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaUsageWorkRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("allows only one owner to claim an exact due work version", async () => {
		await insertWork(ctx, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });

		const claims = await Promise.all([
			repo.claimWork({
				collectionId: "collection-1",
				contentId: "entry-1",
				workVersion: 1,
				leaseDurationSeconds: 60,
			}),
			repo.claimWork({
				collectionId: "collection-1",
				contentId: "entry-1",
				workVersion: 1,
				leaseDurationSeconds: 60,
			}),
		]);

		const winners = claims.filter((workClaim) => workClaim !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]).toEqual(
			expect.objectContaining({
				collectionId: "collection-1",
				contentId: "entry-1",
				workVersion: expect.toSatisfy((value) => Number(value) === 1),
				state: "leased",
			}),
		);
		expect(winners[0]?.leaseToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(winners[0]?.leaseExpiresAt).toBeTruthy();
		expect(winners[0]?.lastAttemptedAt).toBeTruthy();
		expect(winners[0]!.leaseExpiresAt! > winners[0]!.lastAttemptedAt!).toBe(true);
	});

	it("does not claim future, failed, or stale-version work", async () => {
		await insertWork(ctx, { nextAttemptAt: "2999-01-01T00:00:00.000Z" });
		expect(await claimWork(repo, 1)).toBeNull();

		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({ state: "failed", next_attempt_at: "2000-01-01T00:00:00.000Z" })
			.execute();
		expect(await claimWork(repo, 1)).toBeNull();

		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({ state: "pending", work_version: 2 })
			.execute();
		expect(await claimWork(repo, 1)).toBeNull();
		expect(await claimWork(repo, 2)).not.toBeNull();
	});

	it("lets an expired lease be taken over and fences the old owner", async () => {
		await insertWork(ctx, {
			state: "leased",
			nextAttemptAt: "2000-01-01T00:00:00.000Z",
			leaseToken: "old-owner",
			leaseExpiresAt: "2000-01-01T00:01:00.000Z",
		});

		const replacement = await claimWork(repo, 1);
		expect(replacement?.leaseToken).toBeTruthy();
		expect(replacement?.leaseToken).not.toBe("old-owner");
		expect(await repo.completeWork(lease("old-owner", 1))).toBe(false);
		expect(
			await repo.retryWork({
				...lease("old-owner", 1),
				retryDelaySeconds: 1,
				errorCode: "TRANSIENT_DATABASE_FAILURE",
			}),
		).toBe(false);
		expect(
			await repo.failWork({
				...lease("old-owner", 1),
				errorCode: "INVARIANT_FAILURE",
			}),
		).toBe(false);
		expect(await repo.completeWork(lease(replacement!.leaseToken!, 1))).toBe(true);
		expect(await readWork(ctx)).toBeUndefined();
	});

	it("cannot acknowledge or rewrite newer work created during a lease", async () => {
		await insertWork(ctx, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });
		const staleClaim = await claimWork(repo, 1);
		expect(staleClaim).not.toBeNull();

		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({
				work_version: 2,
				change_epoch: 2,
				state: "pending",
				attempt_count: 0,
				next_attempt_at: "2000-01-01T00:00:00.000Z",
				lease_token: null,
				lease_expires_at: null,
				last_error_code: null,
			})
			.execute();

		expect(await repo.completeWork(lease(staleClaim!.leaseToken!, 1))).toBe(false);
		expect(
			await repo.retryWork({
				...lease(staleClaim!.leaseToken!, 1),
				retryDelaySeconds: 1,
				errorCode: "TRANSIENT_DATABASE_FAILURE",
			}),
		).toBe(false);
		expect(
			await repo.failWork({
				...lease(staleClaim!.leaseToken!, 1),
				errorCode: "INVARIANT_FAILURE",
			}),
		).toBe(false);
		expect(await readWork(ctx)).toEqual(
			expect.objectContaining({
				work_version: expect.toSatisfy((value) => Number(value) === 2),
				change_epoch: expect.toSatisfy((value) => Number(value) === 2),
				state: "pending",
				lease_token: null,
				last_error_code: null,
			}),
		);
	});

	it("conditionally retries and terminally fails only a live lease", async () => {
		await insertWork(ctx, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });
		const retryClaim = await claimWork(repo, 1);
		expect(retryClaim).not.toBeNull();

		expect(
			await repo.retryWork({
				...lease(retryClaim!.leaseToken!, 1),
				retryDelaySeconds: 60,
				errorCode: "SNAPSHOT_FAILURE",
			}),
		).toBe(true);
		const retry = await readWork(ctx);
		expect(retry).toEqual(
			expect.objectContaining({
				state: "retry",
				attempt_count: 1,
				lease_token: null,
				lease_expires_at: null,
				last_error_code: "SNAPSHOT_FAILURE",
			}),
		);
		expect(retry!.next_attempt_at > retry!.updated_at).toBe(true);
		expect(await claimWork(repo, 1)).toBeNull();

		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({ next_attempt_at: "2000-01-01T00:00:00.000Z" })
			.execute();
		const failureClaim = await claimWork(repo, 1);
		expect(failureClaim).not.toBeNull();
		expect(
			await repo.failWork({
				...lease(failureClaim!.leaseToken!, 1),
				errorCode: "RESOURCE_LIMIT",
			}),
		).toBe(true);
		expect(await readWork(ctx)).toEqual(
			expect.objectContaining({
				state: "failed",
				attempt_count: 2,
				lease_token: null,
				lease_expires_at: null,
				last_error_code: "RESOURCE_LIMIT",
			}),
		);
		expect(await claimWork(repo, 1)).toBeNull();
	});

	it("rejects every stale transition after lease expiry before takeover", async () => {
		await insertWork(ctx, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });
		const expiredClaim = await claimWork(repo, 1);
		expect(expiredClaim).not.toBeNull();
		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
			.execute();

		const expiredLease = lease(expiredClaim!.leaseToken!, 1);
		expect(await repo.completeWork(expiredLease)).toBe(false);
		expect(
			await repo.retryWork({
				...expiredLease,
				retryDelaySeconds: 1,
				errorCode: "TRANSIENT_DATABASE_FAILURE",
			}),
		).toBe(false);
		expect(await repo.failWork({ ...expiredLease, errorCode: "INVARIANT_FAILURE" })).toBe(false);
		expect(await readWork(ctx)).toEqual(
			expect.objectContaining({ state: "leased", lease_token: expiredClaim!.leaseToken }),
		);
		expect(await claimWork(repo, 1)).not.toBeNull();
	});

	it("rejects non-portable lease durations without changing work", async () => {
		await insertWork(ctx, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });

		await expect(
			repo.claimWork({
				collectionId: "collection-1",
				contentId: "entry-1",
				workVersion: 1,
				leaseDurationSeconds: 0,
			}),
		).rejects.toThrow(/positive whole number/i);
		expect(await readWork(ctx)).toEqual(
			expect.objectContaining({ state: "pending", lease_token: null }),
		);
		await expect(
			repo.claimWork({
				collectionId: "collection-1",
				contentId: "entry-1",
				workVersion: 0,
				leaseDurationSeconds: 60,
			}),
		).rejects.toThrow(/work version/i);
	});

	it("rejects raw error text without releasing a live lease", async () => {
		await insertWork(ctx, { nextAttemptAt: "2000-01-01T00:00:00.000Z" });
		const workClaim = await claimWork(repo, 1);
		expect(workClaim).not.toBeNull();

		await expect(
			repo.retryWork({
				...lease(workClaim!.leaseToken!, 1),
				retryDelaySeconds: 1,
				errorCode: "database connection failed for customer data",
			}),
		).rejects.toThrow(/stable SCREAMING_SNAKE_CASE/i);
		expect(await readWork(ctx)).toEqual(
			expect.objectContaining({
				state: "leased",
				lease_token: workClaim!.leaseToken,
				attempt_count: 0,
				last_error_code: null,
			}),
		);
	});

	it("finds only the current collection instance for a post-write lookup", async () => {
		await insertWork(ctx, {
			collectionId: "obsolete-collection",
			nextAttemptAt: "2000-01-01T00:00:00.000Z",
			updatedAt: "2099-01-01T00:00:00.000Z",
		});
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "current-collection", slug: "posts", label: "Posts" })
			.execute();
		await insertWork(ctx, {
			collectionId: "current-collection",
			nextAttemptAt: "2000-01-01T00:00:00.000Z",
			updatedAt: "2000-01-01T00:00:00.000Z",
		});

		const work = await repo.findWorkForContent("posts", "entry-1");

		expect(work?.collectionId).toBe("current-collection");
	});

	it("selects due pending, retry, and expired-lease work in eligibility order", async () => {
		await insertWork(ctx, {
			contentId: "pending-due",
			nextAttemptAt: "2001-01-01T00:00:00.000Z",
		});
		await insertWork(ctx, {
			contentId: "retry-due",
			state: "retry",
			nextAttemptAt: "2000-01-01T00:00:00.000Z",
		});
		await insertWork(ctx, {
			contentId: "lease-expired",
			state: "leased",
			nextAttemptAt: "2999-01-01T00:00:00.000Z",
			leaseToken: "expired-owner",
			leaseExpiresAt: "1999-01-01T00:00:00.000Z",
		});
		await insertWork(ctx, {
			contentId: "pending-future",
			nextAttemptAt: "2999-01-01T00:00:00.000Z",
		});
		await insertWork(ctx, {
			contentId: "failed",
			state: "failed",
			nextAttemptAt: "1998-01-01T00:00:00.000Z",
		});

		const due = await repo.findDueWork(10);

		expect(due.map((work) => work.contentId)).toEqual([
			"lease-expired",
			"retry-due",
			"pending-due",
		]);
	});
});

function claimWork(repo: MediaUsageWorkRepository, workVersion: number) {
	return repo.claimWork({
		collectionId: "collection-1",
		contentId: "entry-1",
		workVersion,
		leaseDurationSeconds: 60,
	});
}

function lease(leaseToken: string, workVersion: number) {
	return {
		collectionId: "collection-1",
		contentId: "entry-1",
		workVersion,
		leaseToken,
	};
}

async function insertWork(
	ctx: DialectTestContext,
	input: {
		collectionId?: string;
		contentId?: string;
		state?: string;
		nextAttemptAt: string;
		leaseToken?: string | null;
		leaseExpiresAt?: string | null;
		updatedAt?: string;
	},
): Promise<void> {
	await ctx.db
		.insertInto("_emdash_media_usage_work")
		.values({
			collection_id: input.collectionId ?? "collection-1",
			collection_slug: "posts",
			content_id: input.contentId ?? "entry-1",
			change_epoch: 1,
			work_version: 1,
			state: input.state ?? "pending",
			attempt_count: 0,
			next_attempt_at: input.nextAttemptAt,
			lease_token: input.leaseToken ?? null,
			lease_expires_at: input.leaseExpiresAt ?? null,
			updated_at: input.updatedAt,
		})
		.execute();
}

function readWork(ctx: DialectTestContext) {
	return ctx.db.selectFrom("_emdash_media_usage_work").selectAll().executeTakeFirst();
}
