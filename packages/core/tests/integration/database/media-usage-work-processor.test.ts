import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageWorkRepository } from "../../../src/database/repositories/media-usage-work.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database } from "../../../src/database/types.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { MEDIA_USAGE_MAINTENANCE_LIMITS } from "../../../src/media/usage/maintenance-engine.js";
import {
	MEDIA_USAGE_WORK_PROCESSING_LIMITS,
	processDueMediaUsageWork,
	processMediaUsageWorkAfterWrite,
} from "../../../src/media/usage/work-processor.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage durable work processing", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("claims and completes the saved entry's durable job immediately", async () => {
		const fixture = await createActiveFixture(ctx, "posts");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale", reconciliation_required: 0 }),
		);

		const result = await processMediaUsageWorkAfterWrite(ctx.db, "posts", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await countWork(ctx.db)).toBe(0);
		const source = await new MediaUsageRepository(ctx.db).findSource(
			canonicalSourceKey(fixture.collectionId, "entry-1"),
		);
		expect(source).toEqual(
			expect.objectContaining({
				collectionId: fixture.collectionId,
				collectionSlug: "posts",
				contentId: "entry-1",
				identityVersion: 1,
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "complete",
				reconciliation_required: 0,
				last_incremental_success_at: expect.any(String),
				last_error_code: null,
			}),
		);
	});

	it("does not create complete coverage from an untrusted incremental success", async () => {
		const fixture = await createActiveFixture(ctx, "untrusted");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "never", reconciliation_required: 1 })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await insertEntry(ctx, fixture, "entry-1", "media-1");

		const result = await processMediaUsageWorkAfterWrite(ctx.db, "untrusted", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await countWork(ctx.db)).toBe(0);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "never",
				reconciliation_required: 1,
				last_incremental_success_at: expect.any(String),
			}),
		);
	});

	it("does not publish an obsolete terminal failure after newer work arrives", async () => {
		const fixture = await createActiveFixture(ctx, "failure_race");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		const failedVersion = await findWork(ctx.db);
		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({ state: "failed", last_error_code: "OBSOLETE_FAILURE" })
			.where("collection_id", "=", fixture.collectionId)
			.where("content_id", "=", "entry-1")
			.where("work_version", "=", failedVersion.work_version)
			.execute();
		await sql`
			UPDATE ${sql.ref(fixture.tableName)}
			SET title = 'newer projection'
			WHERE id = 'entry-1'
		`.execute(ctx.db);

		const recorded = await new MediaUsageRepository(ctx.db).recordIncrementalFailure({
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
			contentId: "entry-1",
			workVersion: failedVersion.work_version,
			errorCode: "OBSOLETE_FAILURE",
		});

		expect(recorded).toBe(false);
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "pending",
				work_version: expect.toSatisfy(
					(value) => Number(value) === Number(failedVersion.work_version) + 1,
				),
				last_error_code: null,
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale" }),
		);
	});

	it("processes all available work in one bulk batch", async () => {
		const fixture = await createActiveFixture(ctx, "articles");
		for (let index = 0; index < 3; index++) {
			await insertEntry(ctx, fixture, `entry-${index}`, `media-${index}`);
		}

		const result = await processDueMediaUsageWork(ctx.db);

		expect(result.candidateCount).toBe(3);
		expect(result.claimedCount).toBe(3);
		expect(result.completedCount).toBe(3);
		expect(await countWork(ctx.db)).toBe(0);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "complete" }),
		);
	});

	it("does not repeat the full projection query sequence per entry", async () => {
		const fixture = await createActiveFixture(ctx, "bulk_articles");
		for (let index = 0; index < 10; index++) {
			await insertEntry(ctx, fixture, `entry-${index}`, `media-${index}`);
		}
		const counter = new QueryCountingPlugin();

		const result = await processDueMediaUsageWork(ctx.db.withPlugin(counter));

		expect(result.completedCount).toBe(10);
		expect(counter.count).toBeLessThan(50);
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("processes at most one thousand entries per bulk batch", { timeout: 30_000 }, async () => {
		const fixture = await createActiveFixture(ctx, "large_batch");
		for (let index = 0; index < 1_001; index++) {
			await insertEntry(
				ctx,
				fixture,
				`entry-${String(index).padStart(4, "0")}`,
				`media-${index}`,
				20,
			);
		}
		const counter = new QueryCountingPlugin();

		const result = await processDueMediaUsageWork(ctx.db.withPlugin(counter));

		expect(result.claimedCount).toBe(1_000);
		expect(result.completedCount).toBe(1_000);
		expect(counter.count).toBeLessThan(50);
		expect(await countWork(ctx.db)).toBe(1);
	});

	it(
		"releases untouched work when aggregate projection memory is full",
		{ timeout: 30_000 },
		async () => {
			const fixture = await createActiveFixture(ctx, "memory_bound_batch");
			for (let index = 0; index < 101; index++) {
				await insertEntry(
					ctx,
					fixture,
					`entry-${String(index).padStart(3, "0")}`,
					`media-${index}`,
					500,
				);
			}

			const first = await processDueMediaUsageWork(ctx.db);

			expect(first.completedCount).toBeGreaterThan(0);
			expect(first.completedCount).toBeLessThan(101);
			expect(first.retryCount).toBe(0);
			expect(first.failedCount).toBe(0);
			const remaining = await ctx.db
				.selectFrom("_emdash_media_usage_work")
				.select(["state", "attempt_count", "last_error_code"])
				.execute();
			expect(remaining.length).toBeGreaterThan(0);
			expect(
				remaining.every(
					(row) =>
						row.state === "pending" && row.attempt_count === 0 && row.last_error_code === null,
				),
			).toBe(true);

			let completed = first.completedCount;
			for (let step = 0; step < 101 && (await countWork(ctx.db)) > 0; step++) {
				const next = await processDueMediaUsageWork(ctx.db);
				expect(next.retryCount).toBe(0);
				expect(next.failedCount).toBe(0);
				expect(next.completedCount).toBeGreaterThan(0);
				completed += next.completedCount;
			}

			expect(completed).toBe(101);
			expect(await countWork(ctx.db)).toBe(0);
		},
	);

	it("updates existing projections without one query sequence per entry", async () => {
		const fixture = await createActiveFixture(ctx, "existing_batch");
		for (let index = 0; index < 100; index++) {
			await insertEntry(ctx, fixture, `entry-${String(index).padStart(3, "0")}`, `media-${index}`);
		}
		await processDueMediaUsageWork(ctx.db);
		await sql`
			UPDATE ${sql.ref(fixture.tableName)}
			SET hero = ${JSON.stringify({ id: "updated-media", provider: "local", mimeType: "image/webp" })},
				version = version + 1,
				updated_at = '2026-08-20T00:00:00.000Z'
		`.execute(ctx.db);
		const counter = new QueryCountingPlugin();

		const result = await processDueMediaUsageWork(ctx.db.withPlugin(counter));

		expect(result.completedCount).toBe(100);
		expect(counter.count).toBeLessThan(50);
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("lets only one overlapping bulk processor own each work row", async () => {
		const fixture = await createActiveFixture(ctx, "overlapping_bulk");
		for (let index = 0; index < 4; index++) {
			await insertEntry(ctx, fixture, `entry-${index}`, `media-${index}`);
		}

		const results = await Promise.all([
			processDueMediaUsageWork(ctx.db),
			processDueMediaUsageWork(ctx.db),
		]);

		expect(results.reduce((total, result) => total + result.completedCount, 0)).toBe(4);
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("does not release a claimed batch based only on elapsed time", async () => {
		const fixture = await createActiveFixture(ctx, "elapsed_time");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		const metrics = createRequestMetrics(performance.now() - 60 * 60 * 1_000);

		const result = await runWithContext({ editMode: false, metrics }, () =>
			processDueMediaUsageWork(ctx.db),
		);

		expect(result.completedCount).toBe(1);
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("retries every incomplete row after a bulk publication failure", async () => {
		const fixture = await createActiveFixture(ctx, "bulk_failure");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await insertEntry(ctx, fixture, "entry-2", "media-2");
		await installProjectionFailureTrigger(ctx);

		const result = await processDueMediaUsageWork(ctx.db);
		await removeProjectionFailureTrigger(ctx);

		expect(result.retryCount).toBe(2);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_work")
				.select(["state", "attempt_count", "last_error_code"])
				.orderBy("content_id")
				.execute(),
		).toEqual([
			{ state: "retry", attempt_count: 1, last_error_code: "MEDIA_USAGE_PROCESSING_FAILED" },
			{ state: "retry", attempt_count: 1, last_error_code: "MEDIA_USAGE_PROCESSING_FAILED" },
		]);

		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({
				state: "pending",
				attempt_count: MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts - 1,
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
		await installProjectionFailureTrigger(ctx);
		const terminal = await processDueMediaUsageWork(ctx.db);
		await removeProjectionFailureTrigger(ctx);

		expect(terminal.failedCount).toBe(2);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "partial",
				last_error_code: "MEDIA_USAGE_PROCESSING_FAILED",
			}),
		);
	});

	it("does not retry healthy collections when one collection fails", async () => {
		const broken = await createActiveFixture(ctx, "broken_collection");
		const healthy = await createActiveFixture(ctx, "healthy_collection");
		await insertEntry(ctx, broken, "broken-entry", "broken-media");
		await insertEntry(ctx, healthy, "healthy-entry", "healthy-media");
		await installProjectionFailureTrigger(ctx, broken.collectionId);

		const result = await processDueMediaUsageWork(ctx.db);
		await removeProjectionFailureTrigger(ctx);

		expect(result.completedCount).toBe(1);
		expect(result.retryCount).toBe(1);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_work")
				.select(["collection_id", "state", "attempt_count", "last_error_code"])
				.execute(),
		).toEqual([
			{
				collection_id: broken.collectionId,
				state: "retry",
				attempt_count: 1,
				last_error_code: "MEDIA_USAGE_PROCESSING_FAILED",
			},
		]);
		expect(
			await new MediaUsageRepository(ctx.db).findSource(
				canonicalSourceKey(healthy.collectionId, "healthy-entry"),
			),
		).not.toBeNull();
	});

	it("recovers coverage when work deletion committed before its status update", async () => {
		const fixture = await createActiveFixture(ctx, "finalization_recovery");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		const pending = await findWork(ctx.db);
		const work = new MediaUsageWorkRepository(ctx.db);
		const claimed = await work.claimWork({
			collectionId: fixture.collectionId,
			contentId: "entry-1",
			workVersion: pending.work_version,
			leaseDurationSeconds: 60,
		});
		if (!claimed?.leaseToken) throw new Error("Expected claimed work");
		const usage = new MediaUsageRepository(ctx.db);
		const marker = await usage.prepareIncrementalFinalization({
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
		});
		expect(marker.outcome).toBe("marked");
		expect(
			await work.completeWorkBatch([
				{
					collectionId: fixture.collectionId,
					contentId: "entry-1",
					workVersion: claimed.workVersion,
					leaseToken: claimed.leaseToken,
				},
			]),
		).toEqual(
			new Set([`${fixture.collectionId}\u0000entry-1\u0000${String(claimed.workVersion)}`]),
		);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select("collection_id")
				.where("collection_id", "=", fixture.collectionId)
				.where(
					sql<boolean>`cursor LIKE ('incremental-finalize:' || CAST(change_epoch AS text) || ':%')`,
				)
				.executeTakeFirst(),
		).toBeDefined();
		await processDueMediaUsageWork(ctx.db);

		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "complete", cursor: null }),
		);
	});

	it("does not complete an unmarked stale collection with no work", async () => {
		const fixture = await createActiveFixture(ctx, "unmarked_stale");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "stale", completed_at: null, cursor: null })
			.where("collection_id", "=", fixture.collectionId)
			.execute();

		await processDueMediaUsageWork(ctx.db);

		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale", completed_at: null, cursor: null }),
		);
	});

	it("lets only one overlapping fast path own the job", async () => {
		const fixture = await createActiveFixture(ctx, "notes");
		await insertEntry(ctx, fixture, "entry-1", "media-1");

		const outcomes = await Promise.all([
			processMediaUsageWorkAfterWrite(ctx.db, "notes", "entry-1"),
			processMediaUsageWorkAfterWrite(ctx.db, "notes", "entry-1"),
		]);

		expect(outcomes.filter((result) => result.outcome === "completed")).toHaveLength(1);
		expect(await countWork(ctx.db)).toBe(0);
		const source = await new MediaUsageRepository(ctx.db).findSource(
			canonicalSourceKey(fixture.collectionId, "entry-1"),
		);
		expect(source).not.toBeNull();
	});

	it("keeps newer work after projection and redelivers it as a no-op", async () => {
		const fixture = await createActiveFixture(ctx, "pages");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await installProjectionSupersessionTrigger(ctx, "entry-1");

		const stale = await processMediaUsageWorkAfterWrite(ctx.db, "pages", "entry-1");
		expect(stale.outcome).toBe("superseded");
		const sourceBefore = await new MediaUsageRepository(ctx.db).findSource(
			canonicalSourceKey(fixture.collectionId, "entry-1"),
		);
		expect(sourceBefore).not.toBeNull();
		expect(await countWork(ctx.db)).toBe(1);

		await removeProjectionSupersessionTrigger(ctx);
		const redelivery = await processMediaUsageWorkAfterWrite(ctx.db, "pages", "entry-1");
		expect(redelivery.outcome).toBe("completed");
		expect(
			(
				await new MediaUsageRepository(ctx.db).findSource(
					canonicalSourceKey(fixture.collectionId, "entry-1"),
				)
			)?.currentGeneration,
		).toBe(sourceBefore?.currentGeneration);
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("retries snapshot failures and retains the terminal failed row", async () => {
		const fixture = await createActiveFixture(ctx, "news");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await sql`
			INSERT INTO revisions (id, collection, entry_id, data, author_id)
			VALUES ('broken-revision', 'news', 'entry-1', '{', NULL)
		`.execute(ctx.db);
		await sql`
			UPDATE ${sql.ref(fixture.tableName)}
			SET draft_revision_id = 'broken-revision'
			WHERE id = 'entry-1'
		`.execute(ctx.db);

		const retry = await processMediaUsageWorkAfterWrite(ctx.db, "news", "entry-1");
		expect(retry.outcome).toBe("retry");
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "retry",
				attempt_count: 1,
				last_error_code: "MEDIA_USAGE_SNAPSHOT_FAILED",
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale" }),
		);

		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({
				state: "pending",
				attempt_count: MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts - 1,
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
		const failed = await processMediaUsageWorkAfterWrite(ctx.db, "news", "entry-1");
		expect(failed.outcome).toBe("failed");
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "failed",
				attempt_count: MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts,
				last_error_code: "MEDIA_USAGE_SNAPSHOT_FAILED",
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "partial",
				reconciliation_required: 0,
				last_error_code: "MEDIA_USAGE_SNAPSHOT_FAILED",
			}),
		);
	});

	it("reconciles permanent entry absence without leaving work", async () => {
		const fixture = await createActiveFixture(ctx, "documents");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await processMediaUsageWorkAfterWrite(ctx.db, "documents", "entry-1");
		const sourceKey = canonicalSourceKey(fixture.collectionId, "entry-1");
		expect(await new MediaUsageRepository(ctx.db).findSource(sourceKey)).not.toBeNull();

		await sql`DELETE FROM ${sql.ref(fixture.tableName)} WHERE id = 'entry-1'`.execute(ctx.db);
		const result = await processMediaUsageWorkAfterWrite(ctx.db, "documents", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await new MediaUsageRepository(ctx.db).findSource(sourceKey)).toBeNull();
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("discards obsolete work without projecting into a replacement collection", async () => {
		const fixture = await createActiveFixture(ctx, "reused_slug");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await ctx.db.deleteFrom("_emdash_collections").where("id", "=", fixture.collectionId).execute();
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "replacement-collection-id", slug: "reused_slug", label: "Replacement" })
			.execute();

		const result = await processDueMediaUsageWork(ctx.db);

		expect(result.obsoleteCount).toBe(1);
		expect(await countWork(ctx.db)).toBe(0);
		expect(
			await new MediaUsageRepository(ctx.db).findSource(
				canonicalSourceKey(fixture.collectionId, "entry-1"),
			),
		).toBeNull();
	});

	it("keeps an ordinary job inside the shared step reservation", async () => {
		const fixture = await createActiveFixture(ctx, "measured");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		const counter = new QueryCountingPlugin();

		const result = await processMediaUsageWorkAfterWrite(
			ctx.db.withPlugin(counter),
			"measured",
			"entry-1",
		);

		expect(result.outcome).toBe("completed");
		expect(counter.count).toBeGreaterThan(0);
		expect(counter.count).toBeLessThanOrEqual(MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries);
	});
});

class QueryCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count++;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

async function createActiveFixture(ctx: DialectTestContext, collectionSlug: string) {
	const registry = new SchemaRegistry(ctx.db);
	await registry.createCollection({ slug: collectionSlug, label: collectionSlug });
	await registry.createField(collectionSlug, { slug: "title", label: "Title", type: "string" });
	await registry.createField(collectionSlug, { slug: "hero", label: "Hero", type: "image" });
	await registry.createField(collectionSlug, { slug: "body", label: "Body", type: "portableText" });
	const collection = await registry.getCollection(collectionSlug);
	if (!collection) throw new Error(`Expected ${collectionSlug} collection`);

	await ctx.db
		.updateTable("_emdash_media_usage_index_status")
		.set({
			collection_id: collection.id,
			status: "complete",
			completed_at: "2026-08-01T00:00:00.000Z",
			reconciliation_required: 0,
			capture_state: "installing",
		})
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", collectionSlug)
		.execute();
	await installMediaUsageCaptureTriggers(ctx.db, {
		collectionId: collection.id,
		collectionSlug,
	});
	await ctx.db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await ctx.db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
		.execute();

	return {
		collectionId: collection.id,
		collectionSlug,
		tableName: `ec_${collectionSlug}`,
	};
}

async function insertEntry(
	ctx: DialectTestContext,
	fixture: Awaited<ReturnType<typeof createActiveFixture>>,
	contentId: string,
	mediaId: string,
	referenceCount = 1,
): Promise<void> {
	const body = Array.from({ length: Math.max(0, referenceCount - 1) }, (_, index) => ({
		_type: "image",
		asset: { _ref: `${mediaId}-body-${index}` },
	}));
	await sql`
		INSERT INTO ${sql.ref(fixture.tableName)} (id, slug, status, title, hero, body)
		VALUES (
			${contentId},
			${contentId},
			'published',
			${contentId},
			${JSON.stringify({ id: mediaId, provider: "local", mimeType: "image/webp" })},
			${JSON.stringify(body)}
		)
	`.execute(ctx.db);
}

function canonicalSourceKey(
	collectionId: string,
	contentId: string,
	sourceVariant = "columns",
): string {
	return `content:${collectionId}:${contentId}:${sourceVariant}`;
}

async function countWork(db: Kysely<Database>): Promise<number> {
	const result = await db
		.selectFrom("_emdash_media_usage_work")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.executeTakeFirstOrThrow();
	return Number(result.count);
}

async function findWork(db: Kysely<Database>) {
	return db.selectFrom("_emdash_media_usage_work").selectAll().executeTakeFirstOrThrow();
}

async function findCoverageStatus(db: Kysely<Database>, collectionId: string) {
	return db
		.selectFrom("_emdash_media_usage_index_status")
		.selectAll()
		.where("collection_id", "=", collectionId)
		.executeTakeFirstOrThrow();
}

async function installProjectionSupersessionTrigger(
	ctx: DialectTestContext,
	contentId: string,
): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_test_supersede_media_usage_work()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				UPDATE _emdash_media_usage_work
				SET work_version = work_version + 1,
					state = 'pending',
					lease_token = NULL,
					lease_expires_at = NULL,
					next_attempt_at = updated_at
				WHERE content_id = ${sql.lit(contentId)};
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER emdash_test_supersede_media_usage_work
			AFTER INSERT ON _emdash_media_usage_sources
			FOR EACH ROW EXECUTE FUNCTION emdash_test_supersede_media_usage_work()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER emdash_test_supersede_media_usage_work
		AFTER INSERT ON _emdash_media_usage_sources
		FOR EACH ROW
		BEGIN
			UPDATE _emdash_media_usage_work
			SET work_version = work_version + 1,
				state = 'pending',
				lease_token = NULL,
				lease_expires_at = NULL,
				next_attempt_at = updated_at
			WHERE content_id = ${sql.lit(contentId)};
		END
	`.execute(ctx.db);
}

async function removeProjectionSupersessionTrigger(ctx: DialectTestContext): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			DROP TRIGGER emdash_test_supersede_media_usage_work
			ON _emdash_media_usage_sources
		`.execute(ctx.db);
		await sql`DROP FUNCTION emdash_test_supersede_media_usage_work()`.execute(ctx.db);
		return;
	}
	await sql`DROP TRIGGER emdash_test_supersede_media_usage_work`.execute(ctx.db);
}

async function installProjectionFailureTrigger(
	ctx: DialectTestContext,
	collectionId?: string,
): Promise<void> {
	const collectionMatches = collectionId
		? sql<boolean>`NEW.collection_id = ${sql.lit(collectionId)}`
		: sql<boolean>`TRUE`;
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_test_fail_media_usage_projection()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF ${collectionMatches} THEN
					RAISE EXCEPTION 'forced media usage projection failure';
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER emdash_test_fail_media_usage_projection
			BEFORE INSERT ON _emdash_media_usage_sources
			FOR EACH ROW EXECUTE FUNCTION emdash_test_fail_media_usage_projection()
		`.execute(ctx.db);
		return;
	}
	await sql`
		CREATE TRIGGER emdash_test_fail_media_usage_projection
		BEFORE INSERT ON _emdash_media_usage_sources
		WHEN ${collectionMatches}
		BEGIN
			SELECT RAISE(ABORT, 'forced media usage projection failure');
		END
	`.execute(ctx.db);
}

async function removeProjectionFailureTrigger(ctx: DialectTestContext): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			DROP TRIGGER emdash_test_fail_media_usage_projection
			ON _emdash_media_usage_sources
		`.execute(ctx.db);
		await sql`DROP FUNCTION emdash_test_fail_media_usage_projection()`.execute(ctx.db);
		return;
	}
	await sql`DROP TRIGGER emdash_test_fail_media_usage_projection`.execute(ctx.db);
}
