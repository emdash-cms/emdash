import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { processDueMediaUsageCollectionDeletions } from "../../../src/media/usage/collection-deletion-processor.js";
import { loadContentMediaUsageSnapshots } from "../../../src/media/usage/content-snapshots.js";
import { processDueMediaUsageReconciliation } from "../../../src/media/usage/reconciliation-processor.js";
import { MediaUsageReconciliationRepository } from "../../../src/media/usage/reconciliation.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { processDueMediaUsageWork } from "../../../src/media/usage/work-processor.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage reconciliation finalization", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("reconciles historical missing content through existing entry work", async () => {
		const collection = await createCollection(ctx, "articles", true);
		await sql`
			INSERT INTO ${sql.ref("ec_articles")} (id, slug)
			VALUES ('historical', 'historical')
		`.execute(ctx.db);
		const snapshots = await loadContentMediaUsageSnapshots(
			ctx.db,
			collection.slug,
			"historical",
			undefined,
			{ collectionId: collection.id, identityVersion: 1 },
		);
		if (!snapshots.success) throw new Error(snapshots.error);
		const usage = new MediaUsageRepository(ctx.db);
		for (const snapshot of snapshots.snapshots) {
			await usage.replaceSourceIfMatching(snapshot.source, snapshot.occurrences, null);
		}
		const quarantinedSourceKey = buildContentMediaUsageSourceKey({
			collectionId: collection.id,
			collectionSlug: collection.slug,
			contentId: "quarantined",
			sourceVariant: "columns",
		});
		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: quarantinedSourceKey,
				source_type: "content",
				collection_id: collection.id,
				collection_slug: collection.slug,
				content_id: "quarantined",
				source_variant: "columns",
				current_generation: "legacy-generation",
				identity_version: null,
			})
			.execute();
		await sql`DELETE FROM ${sql.ref("ec_articles")} WHERE id = 'historical'`.execute(ctx.db);
		await activateCollection(ctx, collection);

		await expect(processDueMediaUsageReconciliation(ctx.db)).resolves.toBe("advanced");
		await expect(processDueMediaUsageReconciliation(ctx.db)).resolves.toBe("advanced");
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_work")
				.select(["content_id", "state"])
				.where("collection_id", "=", collection.id)
				.execute(),
		).toEqual([{ content_id: "historical", state: "pending" }]);

		await expect(processDueMediaUsageWork(ctx.db)).resolves.toMatchObject({ completedCount: 1 });
		expect(await usage.findSource(snapshots.snapshots[0]!.source.sourceKey)).toBeNull();
		await expect(processDueMediaUsageReconciliation(ctx.db)).resolves.toBe("completed");

		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select(["status", "reconciliation_required", "cursor", "last_error_code"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			status: "complete",
			reconciliation_required: 0,
			cursor: null,
			last_error_code: null,
		});
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("collection_id")
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toBeUndefined();
		expect(await usage.findSource(quarantinedSourceKey)).not.toBeNull();
	});

	it("preserves automatic ownership until failed work reaches terminal coverage", async () => {
		const collection = await createCollection(ctx, "articles", true);
		await sql`
			INSERT INTO ${sql.ref("ec_articles")} (id, slug)
			VALUES ('entry-1', 'entry-1')
		`.execute(ctx.db);
		await activateCollection(ctx, collection);
		await expect(processDueMediaUsageReconciliation(ctx.db)).resolves.toBe("advanced");
		const coordinator = await ctx.db
			.selectFrom("_emdash_media_usage_reconciliations")
			.select(["run_token", "target_epoch"])
			.where("collection_id", "=", collection.id)
			.executeTakeFirstOrThrow();
		const work = await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({ state: "failed", last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT" })
			.where("collection_id", "=", collection.id)
			.returning(["content_id", "work_version"])
			.executeTakeFirstOrThrow();
		await new MediaUsageRepository(ctx.db).recordIncrementalFailure({
			collectionId: collection.id,
			collectionSlug: collection.slug,
			contentId: work.content_id,
			workVersion: work.work_version,
			errorCode: "MEDIA_USAGE_RESOURCE_LIMIT",
		});

		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select(["status", "cursor", "last_error_code"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			status: "running",
			cursor: coordinator.run_token,
			last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT",
		});
		await expect(processDueMediaUsageReconciliation(ctx.db)).resolves.toBe("failed");

		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select(["state", "last_error_code", "target_epoch"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			state: "failed",
			last_error_code: "MEDIA_USAGE_RECONCILIATION_ENTRY_FAILED",
			target_epoch: coordinator.target_epoch,
		});
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select(["status", "reconciliation_required", "cursor", "last_error_code"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			status: "failed",
			reconciliation_required: 1,
			cursor: null,
			last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT",
		});
	});

	it("collection deletion removes the exact reconciliation row before status", async () => {
		const collection = await createCollection(ctx, "articles", false);
		await activateCollection(ctx, collection);
		await processDueMediaUsageReconciliation(ctx.db);
		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: collection.id,
				collection_slug: collection.slug,
				force_delete: 1,
				state: "pending",
				phase: "status",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(processDueMediaUsageCollectionDeletions(ctx.db)).resolves.toMatchObject({
			outcome: "progress",
		});
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("collection_id")
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toBeUndefined();
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select("collection_id")
				.where("collection_id", "=", collection.id)
				.executeTakeFirst(),
		).toBeUndefined();
	});

	it("does not persist terminal entry failure after work has been reopened", async () => {
		const collection = await createCollection(ctx, "articles", true);
		await sql`
			INSERT INTO ${sql.ref("ec_articles")} (id, slug)
			VALUES ('entry-1', 'entry-1')
		`.execute(ctx.db);
		await activateCollection(ctx, collection);
		await processDueMediaUsageReconciliation(ctx.db);
		const repository = new MediaUsageReconciliationRepository(ctx.db);
		const [candidate] = await repository.findDue(4);
		if (!candidate) throw new Error("Expected reconciliation work");
		const claim = await repository.claim({
			collectionId: candidate.collectionId,
			runToken: candidate.runToken,
			leaseDurationSeconds: 60,
		});
		if (!claim) throw new Error("Expected reconciliation claim");

		await expect(repository.recordEntryFailure(claim)).resolves.toBe(false);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("state")
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ state: "leased" });
	});

	it("restarts from a new epoch after a schema fingerprint changes", async () => {
		const collection = await createCollection(ctx, "articles", true);
		await sql`
			INSERT INTO ${sql.ref("ec_articles")} (id, slug)
			VALUES ('entry-1', 'entry-1')
		`.execute(ctx.db);
		await activateCollection(ctx, collection);
		await processDueMediaUsageReconciliation(ctx.db);
		await processDueMediaUsageWork(ctx.db);
		await processDueMediaUsageReconciliation(ctx.db);
		const before = await ctx.db
			.selectFrom("_emdash_media_usage_reconciliations")
			.select(["target_epoch", "field_fingerprint", "phase"])
			.where("collection_id", "=", collection.id)
			.executeTakeFirstOrThrow();

		await new SchemaRegistry(ctx.db).createField("articles", {
			slug: "attachment",
			label: "Attachment",
			type: "file",
		});
		await expect(processDueMediaUsageReconciliation(ctx.db)).resolves.toBe("advanced");
		const after = await ctx.db
			.selectFrom("_emdash_media_usage_reconciliations")
			.select(["target_epoch", "field_fingerprint", "phase", "scan_cursor", "source_cursor"])
			.where("collection_id", "=", collection.id)
			.executeTakeFirstOrThrow();

		expect(Number(after.target_epoch)).toBeGreaterThan(Number(before.target_epoch));
		expect(after.field_fingerprint).not.toBe(before.field_fingerprint);
		expect(after).toMatchObject({ phase: "scan", scan_cursor: null, source_cursor: null });
	});

	it("defers without taking coverage from a manual repair owner", async () => {
		const collection = await createCollection(ctx, "articles", true);
		await sql`
			INSERT INTO ${sql.ref("ec_articles")} (id, slug)
			VALUES ('entry-1', 'entry-1')
		`.execute(ctx.db);
		await activateCollection(ctx, collection);
		await processDueMediaUsageReconciliation(ctx.db);
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "running", cursor: "manual-repair" })
			.where("collection_id", "=", collection.id)
			.execute();

		await expect(processDueMediaUsageReconciliation(ctx.db)).resolves.toBe("deferred");
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select(["status", "cursor"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "running", cursor: "manual-repair" });
	});

	it("retains the claimed epoch when initialization fails terminally", async () => {
		const collection = await createCollection(ctx, "articles", true);
		await activateCollection(ctx, collection);
		const repository = new MediaUsageReconciliationRepository(ctx.db);
		await repository.seedNextCandidate();
		const [candidate] = await repository.findDue(4);
		if (!candidate) throw new Error("Expected reconciliation candidate");
		const claim = await repository.claim({
			collectionId: candidate.collectionId,
			runToken: candidate.runToken,
			leaseDurationSeconds: 60,
		});
		if (!claim) throw new Error("Expected reconciliation claim");
		const epoch = await repository.beginRun(claim);
		if (epoch === null) throw new Error("Expected a claimed coverage epoch");

		await repository.recordFailure({
			collectionId: claim.collectionId,
			runToken: claim.runToken,
			leaseToken: claim.leaseToken,
			errorCode: "MEDIA_USAGE_RECONCILIATION_FAILED",
			retryDelaySeconds: 0,
			terminal: true,
		});
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select(["state", "target_epoch"])
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ state: "failed", target_epoch: epoch });
	});
});

async function createCollection(
	ctx: DialectTestContext,
	slug: string,
	withMediaField: boolean,
): Promise<{ id: string; slug: string }> {
	const registry = new SchemaRegistry(ctx.db);
	await registry.createCollection({ slug, label: slug });
	if (withMediaField) {
		await registry.createField(slug, { slug: "hero", label: "Hero", type: "image" });
	}
	const collection = await registry.getCollection(slug);
	if (!collection) throw new Error(`Expected ${slug} collection`);
	return { id: collection.id, slug: collection.slug };
}

async function activateCollection(
	ctx: DialectTestContext,
	collection: { id: string; slug: string },
): Promise<void> {
	await ctx.db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: "content-media",
			scope_type: "collection",
			scope_key: collection.slug,
			collection_id: collection.id,
			status: "stale",
			capture_state: "active",
			reconciliation_required: 1,
		})
		.onConflict((conflict) =>
			conflict.columns(["adapter_id", "scope_type", "scope_key"]).doUpdateSet({
				collection_id: collection.id,
				status: "stale",
				capture_state: "active",
				reconciliation_required: 1,
			}),
		)
		.execute();
	await ctx.db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active" })
		.where("task_key", "=", "incremental_capture")
		.execute();
}
