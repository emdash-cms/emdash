import { afterEach, beforeEach, expect, it } from "vitest";

import { indexExists, tableExists } from "../../../src/database/dialect-helpers.js";
import { MediaUsageReconciliationRepository } from "../../../src/media/usage/reconciliation.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage reconciliation foundation", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("installs the durable coordinator schema with dormant scheduling", async () => {
		expect(await tableExists(ctx.db, "_emdash_media_usage_reconciliations")).toBe(true);
		expect(await indexExists(ctx.db, "idx__emdash_media_usage_reconciliations_due")).toBe(true);
		expect(await indexExists(ctx.db, "idx__emdash_media_usage_reconciliations_lease")).toBe(true);
		expect(await indexExists(ctx.db, "idx__emdash_media_usage_reconciliations_failed")).toBe(true);
		expect(await indexExists(ctx.db, "idx__emdash_media_usage_status_reconciliation")).toBe(true);

		const activation = await ctx.db
			.selectFrom("_emdash_media_usage_activation")
			.select(["state", "media_usage_maintenance_turn"])
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();
		expect(activation).toEqual({ state: "expanded", media_usage_maintenance_turn: 2 });
	});

	it("seeds at most one exact active collection per invocation", async () => {
		const first = await createActiveCollection(ctx, "articles");
		const second = await createActiveCollection(ctx, "pages");
		const repository = new MediaUsageReconciliationRepository(ctx.db);

		await expect(repository.seedNextCandidate()).resolves.toBe(false);
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "active" })
			.where("task_key", "=", "incremental_capture")
			.execute();

		await expect(repository.seedNextCandidate()).resolves.toBe(true);
		expect(await reconciliationIdentities(ctx)).toHaveLength(1);
		await expect(repository.seedNextCandidate()).resolves.toBe(true);
		expect(await reconciliationIdentities(ctx)).toEqual(
			[first, second].toSorted((left, right) => left.id.localeCompare(right.id)),
		);
		await expect(repository.seedNextCandidate()).resolves.toBe(false);
	});

	it("excludes inactive, complete, and deleting collections from discovery", async () => {
		await createActiveCollection(ctx, "inactive", { captureState: "installing" });
		await createActiveCollection(ctx, "complete", { reconciliationRequired: 0 });
		await createActiveCollection(ctx, "deleting", { captureState: "deleting" });
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "active" })
			.where("task_key", "=", "incremental_capture")
			.execute();

		const repository = new MediaUsageReconciliationRepository(ctx.db);
		await expect(repository.seedNextCandidate()).resolves.toBe(false);
		expect(await reconciliationIdentities(ctx)).toEqual([]);
	});

	it("claims due work once and fences stale lease owners", async () => {
		const collection = await createActiveCollection(ctx, "articles");
		await activateAndSeed(ctx);
		const repository = new MediaUsageReconciliationRepository(ctx.db);
		const [candidate] = await repository.findDue(4);
		if (!candidate) throw new Error("Expected a due reconciliation candidate");

		const claim = await repository.claim({
			collectionId: collection.id,
			runToken: candidate.runToken,
			leaseDurationSeconds: 60,
		});
		expect(claim).toMatchObject({ state: "leased", collectionId: collection.id });
		await expect(
			repository.claim({
				collectionId: collection.id,
				runToken: candidate.runToken,
				leaseDurationSeconds: 60,
			}),
		).resolves.toBeNull();

		await expect(
			repository.release({
				collectionId: collection.id,
				runToken: candidate.runToken,
				leaseToken: "stale-owner",
				delaySeconds: 30,
			}),
		).resolves.toBe(false);
		await expect(
			repository.release({
				collectionId: collection.id,
				runToken: candidate.runToken,
				leaseToken: claim!.leaseToken,
				delaySeconds: 30,
			}),
		).resolves.toBe(true);
	});

	it("does not claim a coordinator after coverage becomes complete", async () => {
		const collection = await createActiveCollection(ctx, "articles");
		await activateAndSeed(ctx);
		const repository = new MediaUsageReconciliationRepository(ctx.db);
		const [candidate] = await repository.findDue(4);
		if (!candidate) throw new Error("Expected a due reconciliation candidate");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "complete", reconciliation_required: 0 })
			.where("collection_id", "=", collection.id)
			.execute();

		await expect(
			repository.claim({
				collectionId: collection.id,
				runToken: candidate.runToken,
				leaseDurationSeconds: 60,
			}),
		).resolves.toBeNull();
	});

	it("persists bounded retry and terminal failure without hot-looping", async () => {
		await createActiveCollection(ctx, "articles");
		await activateAndSeed(ctx);
		const repository = new MediaUsageReconciliationRepository(ctx.db);
		const [candidate] = await repository.findDue(4);
		if (!candidate) throw new Error("Expected a due reconciliation candidate");
		const firstClaim = await repository.claim({
			collectionId: candidate.collectionId,
			runToken: candidate.runToken,
			leaseDurationSeconds: 60,
		});
		if (!firstClaim) throw new Error("Expected the first reconciliation claim");

		await expect(
			repository.recordFailure({
				collectionId: candidate.collectionId,
				runToken: candidate.runToken,
				leaseToken: firstClaim.leaseToken,
				errorCode: "MEDIA_USAGE_RECONCILIATION_FAILED",
				retryDelaySeconds: 30,
				terminal: false,
			}),
		).resolves.toBe(true);
		expect(await repository.findDue(4)).toEqual([]);

		await ctx.db
			.updateTable("_emdash_media_usage_reconciliations")
			.set({ next_attempt_at: "2000-01-01T00:00:00.000Z" })
			.where("collection_id", "=", candidate.collectionId)
			.execute();
		const retryClaim = await repository.claim({
			collectionId: candidate.collectionId,
			runToken: candidate.runToken,
			leaseDurationSeconds: 60,
		});
		if (!retryClaim) throw new Error("Expected the retry reconciliation claim");
		await expect(
			repository.recordFailure({
				collectionId: candidate.collectionId,
				runToken: candidate.runToken,
				leaseToken: retryClaim.leaseToken,
				errorCode: "MEDIA_USAGE_RECONCILIATION_INVALID_SOURCE",
				retryDelaySeconds: 0,
				terminal: true,
			}),
		).resolves.toBe(true);

		expect(await repository.findDue(4)).toEqual([]);
		expect(await repository.findFailed(4)).toEqual([]);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select(["collection_id", "state", "attempt_count", "last_error_code"])
				.where("collection_id", "=", candidate.collectionId)
				.executeTakeFirstOrThrow(),
		).toEqual({
			collection_id: candidate.collectionId,
			state: "failed",
			attempt_count: 2,
			last_error_code: "MEDIA_USAGE_RECONCILIATION_INVALID_SOURCE",
		});
	});

	it("reopens failed work only after a newer coverage epoch", async () => {
		const collection = await createActiveCollection(ctx, "articles");
		await activateAndSeed(ctx);
		const repository = new MediaUsageReconciliationRepository(ctx.db);
		const row = await ctx.db
			.updateTable("_emdash_media_usage_reconciliations")
			.set({
				state: "failed",
				target_epoch: 4,
				attempt_count: 5,
				last_error_code: "MEDIA_USAGE_RECONCILIATION_FAILED",
			})
			.where("collection_id", "=", collection.id)
			.returningAll()
			.executeTakeFirstOrThrow();

		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ change_epoch: 4, cursor: null })
			.where("collection_id", "=", collection.id)
			.execute();
		await expect(repository.resetFailedForNewEpoch(row)).resolves.toBe(false);

		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ change_epoch: 5 })
			.where("collection_id", "=", collection.id)
			.execute();
		await expect(repository.resetFailedForNewEpoch(row)).resolves.toBe(true);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select(["state", "target_epoch", "attempt_count", "last_error_code"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ state: "pending", target_epoch: null, attempt_count: 0, last_error_code: null });
	});

	it("refuses rollback while reconciliation evidence exists", async () => {
		const migration =
			await import("../../../src/database/migrations/066_media_usage_reconciliation.js");
		await ctx.db
			.insertInto("_emdash_media_usage_reconciliations")
			.values({
				collection_id: "collection-1",
				collection_slug: "articles",
				run_token: "run-1",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(migration.down(ctx.db)).rejects.toThrow(/reconciliation evidence/i);
	});
});

async function createActiveCollection(
	ctx: DialectTestContext,
	slug: string,
	options: { captureState?: string; reconciliationRequired?: number } = {},
): Promise<{ id: string; slug: string }> {
	const registry = new SchemaRegistry(ctx.db);
	await registry.createCollection({ slug, label: slug });
	const collection = await registry.getCollection(slug);
	if (!collection) throw new Error(`Expected ${slug} collection`);
	await ctx.db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: "content-media",
			scope_type: "collection",
			scope_key: collection.slug,
			collection_id: collection.id,
			status: "stale",
			capture_state: options.captureState ?? "active",
			reconciliation_required: options.reconciliationRequired ?? 1,
		})
		.execute();
	return { id: collection.id, slug: collection.slug };
}

async function activateAndSeed(ctx: DialectTestContext): Promise<void> {
	await ctx.db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active" })
		.where("task_key", "=", "incremental_capture")
		.execute();
	const repository = new MediaUsageReconciliationRepository(ctx.db);
	await expect(repository.seedNextCandidate()).resolves.toBe(true);
}

async function reconciliationIdentities(
	ctx: DialectTestContext,
): Promise<{ id: string; slug: string }[]> {
	const rows = await ctx.db
		.selectFrom("_emdash_media_usage_reconciliations")
		.select(["collection_id", "collection_slug"])
		.orderBy("collection_id")
		.execute();
	return rows.map((row) => ({ id: row.collection_id, slug: row.collection_slug }));
}
