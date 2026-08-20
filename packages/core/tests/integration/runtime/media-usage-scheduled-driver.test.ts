import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import {
	sql,
	SqliteDialect,
	type KyselyPlugin,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	type QueryResult,
	type RootOperationNode,
	type UnknownRow,
} from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { activateMediaUsageCapture } from "../../../src/media/usage/activation.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import {
	MEDIA_USAGE_MAINTENANCE_LIMITS,
	runMediaUsageMaintenanceSlice,
} from "../../../src/media/usage/maintenance-engine.js";
import { processDueMediaUsageReconciliation } from "../../../src/media/usage/reconciliation-processor.js";
import { processDueMediaUsageWork } from "../../../src/media/usage/work-processor.js";
import type {
	CronScheduler,
	MediaUsageContinuationFn,
	SystemCleanupFn,
} from "../../../src/plugins/scheduler/types.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";

describe("media usage scheduled drivers", () => {
	let runtime: EmDashRuntime | null = null;

	afterEach(async () => {
		await runtime?.stopCron();
		runtime = null;
	});

	it("skips idle maintenance classes and processes due entry work", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "work_conserving_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "progress",
			continuation: { kind: "immediate" },
		});
		expect(await countWork(runtime)).toBe(0);
	});

	it("processes one due entry batch per maintenance step", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "one_unit_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await insertEntry(runtime, fixture.tableName, "entry-2");

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toMatchObject({
			state: "progress",
			continuation: { kind: "immediate" },
		});
		expect(await countWork(runtime)).toBe(0);
	});

	it("delays one continuation when every visible claim is blocked", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "blocked_claim_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await sql`
			CREATE TRIGGER block_media_usage_work_claim
			BEFORE UPDATE OF state ON _emdash_media_usage_work
			WHEN NEW.state = 'leased'
			BEGIN
				SELECT RAISE(IGNORE);
			END
		`.execute(runtime.db);

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
		});
		expect(await countWork(runtime)).toBe(1);
	});

	it("keeps a delayed continuation while retry work is waiting", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "delayed_retry_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await runtime.db
			.updateTable("_emdash_media_usage_work")
			.set({ state: "retry", next_attempt_at: "2100-01-01T00:00:00.000Z" })
			.execute();

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
		});
		expect(await countWork(runtime)).toBe(1);
	});

	it("continues useful entry work after a reconciliation claim is lost", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const work = await activateCollection(runtime, "seed_claim_work");
		await insertEntry(runtime, work.tableName, "entry-1");
		const reconciliation = await activateCollection(runtime, "seed_claim_reconciliation");
		await runtime.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "stale", reconciliation_required: 1 })
			.where("collection_id", "=", reconciliation.collectionId)
			.execute();
		await sql`
			CREATE TRIGGER block_media_usage_reconciliation_claim
			BEFORE UPDATE OF state ON _emdash_media_usage_reconciliations
			WHEN NEW.state = 'leased'
			BEGIN
				SELECT RAISE(IGNORE);
			END
		`.execute(runtime.db);

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "progress",
			continuation: { kind: "immediate" },
		});
		expect(await countWork(runtime)).toBe(0);
	});

	it("keeps a blocked due reconciliation on its delayed continuation", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "blocked_due_reconciliation");
		const runToken = "blocked-due-run";
		await runtime.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				status: "running",
				cursor: runToken,
				change_epoch: 1,
				reconciliation_required: 1,
			})
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await runtime.db
			.insertInto("_emdash_media_usage_reconciliations")
			.values({
				collection_id: fixture.collectionId,
				collection_slug: "blocked_due_reconciliation",
				run_token: runToken,
				target_epoch: 1,
				field_fingerprint: "blocked-due-fields",
				state: "pending",
				phase: "sources",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
		await sql`
			CREATE TRIGGER block_due_reconciliation_claim
			BEFORE UPDATE OF state ON _emdash_media_usage_reconciliations
			WHEN NEW.state = 'leased'
			BEGIN
				SELECT RAISE(IGNORE);
			END
		`.execute(runtime.db);

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toMatchObject({
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
		});
	});

	it("stops continuation only after a full idle maintenance pass", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await activateCollection(runtime, "idle_posts");

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "idle",
			continuation: { kind: "none" },
		});
	});

	it("continues reconciliation immediately after entry work drains", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await runtime.schemaRegistry.createCollection({
			slug: "deferred_reconciliation",
			label: "Deferred reconciliation",
		});
		await runtime.schemaRegistry.createField("deferred_reconciliation", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await runtime.schemaRegistry.createField("deferred_reconciliation", {
			slug: "image",
			label: "Image",
			type: "image",
		});
		await sql`
			INSERT INTO ${sql.ref("ec_deferred_reconciliation")} (id, slug, status, title)
			VALUES
				('entry-1', 'entry-1', 'published', 'Entry 1'),
				('entry-2', 'entry-2', 'published', 'Entry 2')
		`.execute(runtime.db);
		await expect(activateMediaUsageCapture(runtime.db, { writersDrained: true })).resolves.toEqual({
			outcome: "active",
			processedCollections: 1,
		});

		await expect(processDueMediaUsageReconciliation(runtime.db)).resolves.toBe("advanced");
		await expect(processDueMediaUsageReconciliation(runtime.db)).resolves.toBe("deferred");
		await processDueMediaUsageWork(runtime.db);
		await processDueMediaUsageWork(runtime.db);
		expect(await countWork(runtime)).toBe(0);
		expect(
			await runtime.db.selectFrom("_emdash_media_usage_reconciliations").select("state").execute(),
		).toEqual([expect.objectContaining({ state: "pending" })]);

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toMatchObject({
			state: "progress",
			continuation: { kind: "immediate" },
		});
	});

	it("offers every due maintenance class one opportunity per cycle", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const work = await activateCollection(runtime, "fair_engine_work");
		await insertEntry(runtime, work.tableName, "entry-1");
		const deletion = await activateCollection(runtime, "fair_engine_delete");
		await runtime.schemaRegistry.deleteCollection("fair_engine_delete", { force: true });
		const reconciliation = await activateCollection(runtime, "fair_engine_reconciliation");
		await runtime.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "stale", reconciliation_required: 1 })
			.where("collection_id", "=", reconciliation.collectionId)
			.execute();

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toMatchObject({
			state: "progress",
			continuation: { kind: "immediate" },
		});
		expect(await countWork(runtime)).toBe(0);
		expect(await deletionPhase(runtime, deletion.collectionId)).toBe("sources");
		expect(
			await runtime.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("collection_id")
				.where("collection_id", "=", reconciliation.collectionId)
				.executeTakeFirst(),
		).toBeDefined();
	});

	it("drains work after an explicit Node wake", async () => {
		const scheduler = new ContinuousCapturingScheduler();
		runtime = await EmDashRuntime.create(createDeps(() => scheduler));
		const fixture = await activateCollection(runtime, "continuous_node_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await insertEntry(runtime, fixture.tableName, "entry-2");

		runtime.wakeMediaUsageMaintenance();
		expect(scheduler.wakeCount).toBe(1);
		await expect(scheduler.runContinuation()).resolves.toEqual({ kind: "immediate" });
		expect(await countWork(runtime)).toBe(0);
		await expect(scheduler.runContinuation()).resolves.toEqual({ kind: "none" });
	});

	it("drains several durable units inside one Cloudflare maintenance slice", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "slice_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await insertEntry(runtime, fixture.tableName, "entry-2");
		await insertEntry(runtime, fixture.tableName, "entry-3");
		const metrics = createRequestMetrics(performance.now());

		const continuation = await runWithContext({ editMode: false, metrics }, () =>
			runtime!.runMediaUsageMaintenanceSlice(),
		);

		expect(continuation).toEqual({ kind: "none" });
		expect(await countWork(runtime)).toBe(0);
	});

	it("does not re-probe idle classes while draining historical coverage", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await runtime.schemaRegistry.createCollection({ slug: "bulk_history", label: "Bulk history" });
		await runtime.schemaRegistry.createField("bulk_history", {
			slug: "hero",
			label: "Hero",
			type: "image",
		});
		await sql`
			WITH RECURSIVE sequence(value) AS (
				VALUES (0)
				UNION ALL
				SELECT value + 1 FROM sequence WHERE value < 499
			)
			INSERT INTO ${sql.ref("ec_bulk_history")} (id, slug, status, hero)
			SELECT
				printf('entry-%03d', value),
				printf('entry-%03d', value),
				'published',
				json_object('id', printf('media-%03d', value), 'provider', 'local')
			FROM sequence
		`.execute(runtime.db);
		await expect(
			activateMediaUsageCapture(runtime.db, { writersDrained: true }),
		).resolves.toMatchObject({ outcome: "active" });
		const counter = new QueryCountingPlugin();
		const metrics = createRequestMetrics(performance.now());

		await expect(
			runWithContext({ editMode: false, metrics }, () =>
				runMediaUsageMaintenanceSlice(runtime!.db.withPlugin(counter)),
			),
		).resolves.toEqual({ kind: "none" });

		expect(counter.count).toBeLessThan(75);
	});

	it("runs one complete batch when a direct slice caller has no query metrics", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "unmetered_slice_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await insertEntry(runtime, fixture.tableName, "entry-2");

		await expect(runtime.runMediaUsageMaintenanceSlice()).resolves.toEqual({ kind: "immediate" });
		expect(await countWork(runtime)).toBe(0);
	});

	it("stops before another unit when the remaining Paid query budget is reserved", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "query_bound_slice_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await insertEntry(runtime, fixture.tableName, "entry-2");
		const metrics = createRequestMetrics(performance.now());
		metrics.dbCount =
			MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling -
			MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries -
			10;

		const continuation = await runWithContext({ editMode: false, metrics }, () =>
			runtime!.runMediaUsageMaintenanceSlice(),
		);

		expect(continuation).toEqual({ kind: "immediate" });
		expect(await countWork(runtime)).toBe(0);
	});

	it("rechecks the event query budget between due maintenance classes", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const work = await activateCollection(runtime, "bounded_cycle_work");
		await insertEntry(runtime, work.tableName, "entry-1");
		const deletion = await activateCollection(runtime, "bounded_cycle_delete");
		await runtime.schemaRegistry.deleteCollection("bounded_cycle_delete", { force: true });
		const reconciliation = await activateCollection(runtime, "bounded_cycle_reconciliation");
		await runtime.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "stale", reconciliation_required: 1 })
			.where("collection_id", "=", reconciliation.collectionId)
			.execute();
		const metrics = createRequestMetrics(performance.now());
		metrics.dbCount =
			MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling -
			MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries -
			1;

		await expect(
			runWithContext({ editMode: false, metrics }, () => runtime!.runMediaUsageMaintenanceStep()),
		).resolves.toMatchObject({
			state: "progress",
			continuation: { kind: "immediate" },
		});
		expect(await deletionPhase(runtime, deletion.collectionId)).toBe("sources");
		expect(await countWork(runtime)).toBe(1);
		expect(
			await runtime.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("collection_id")
				.where("collection_id", "=", reconciliation.collectionId)
				.executeTakeFirst(),
		).toBeUndefined();
	});

	it("does not create a no-progress continuation when initialization spent the query budget", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "spent_slice_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		const metrics = createRequestMetrics(performance.now());
		metrics.dbCount =
			MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling -
			MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries +
			1;

		const continuation = await runWithContext({ editMode: false, metrics }, () =>
			runtime!.runMediaUsageMaintenanceSlice(),
		);

		expect(continuation).toEqual({ kind: "none" });
		expect(await countWork(runtime)).toBe(1);
	});

	it("does not start a unit after the Cloudflare slice deadline", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "timed_slice_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		const metrics = createRequestMetrics(
			performance.now() - MEDIA_USAGE_MAINTENANCE_LIMITS.stepStartDeadlineMs,
		);

		const continuation = await runWithContext({ editMode: false, metrics }, () =>
			runtime!.runMediaUsageMaintenanceSlice(),
		);

		expect(continuation).toEqual({ kind: "none" });
		expect(await countWork(runtime)).toBe(1);
	});

	it("continues a metered Queue slice beyond the old twenty-second cutoff", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "long_io_slice_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await insertEntry(runtime, fixture.tableName, "entry-2");
		const metrics = createRequestMetrics(performance.now() - 20_001);

		const continuation = await runWithContext({ editMode: false, metrics }, () =>
			runtime!.runMediaUsageMaintenanceSlice(),
		);

		expect(continuation).toEqual({ kind: "none" });
		expect(await countWork(runtime)).toBe(0);
	});

	it("starts reconciliation from an explicit Node wake", async () => {
		const scheduler = new ContinuousCapturingScheduler();
		const metrics = createRequestMetrics(performance.now());
		runtime = await EmDashRuntime.create(createDeps(() => scheduler));
		await runtime.schemaRegistry.createCollection({
			slug: "node_reconciliation",
			label: "Node reconciliation",
		});
		await runtime.schemaRegistry.createField("node_reconciliation", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await sql`
			INSERT INTO ${sql.ref("ec_node_reconciliation")} (id, slug, status, title)
			VALUES ('existing-entry', 'existing-entry', 'published', 'Existing entry')
		`.execute(runtime.db);
		metrics.dbCount = MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling;

		await expect(activateMediaUsageCapture(runtime.db, { writersDrained: true })).resolves.toEqual({
			outcome: "active",
			processedCollections: 1,
		});
		expect(
			await runtime.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("collection_id")
				.executeTakeFirst(),
		).toBeUndefined();

		await runWithContext({ editMode: false, metrics }, async () => {
			runtime!.wakeMediaUsageMaintenance();
			await scheduler.runContinuation();
			await scheduler.runContinuation();
			await scheduler.runContinuation();
		});

		const reconciliation = await runtime.db
			.selectFrom("_emdash_media_usage_reconciliations")
			.select("collection_id")
			.executeTakeFirst();
		const coverage = await runtime.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("status")
			.where("scope_key", "=", "node_reconciliation")
			.executeTakeFirstOrThrow();
		expect(reconciliation !== undefined || coverage.status === "complete").toBe(true);
	});

	it("advances bounded collection deletion from an explicit Node wake", async () => {
		const scheduler = new ContinuousCapturingScheduler();
		runtime = await EmDashRuntime.create(createDeps(() => scheduler));
		const fixture = await activateCollection(runtime, "node_delete");
		await runtime.schemaRegistry.deleteCollection("node_delete", { force: true });

		runtime.wakeMediaUsageMaintenance();
		await scheduler.runContinuation();
		await scheduler.runContinuation();

		expect(await deletionPhase(runtime, fixture.collectionId)).toBe("status");
	});

	it("processes a trigger-created job before returning from an authenticated write", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "fast_posts");

		const result = await runtime.handleContentCreate("fast_posts", {
			slug: "entry-1",
			status: "published",
			data: { title: "Entry 1" },
		});

		expect(result.success).toBe(true);
		const contentId = result.data?.item.id;
		expect(contentId).toBeTruthy();
		expect(await countWork(runtime)).toBe(0);
		expect(
			await new MediaUsageRepository(runtime.db).findSource(
				canonicalSourceKey(fixture.collectionId, contentId!),
			),
		).not.toBeNull();
	});

	it("continues confirmed activation one bounded collection at a time", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await runtime.schemaRegistry.createCollection({ slug: "activation_alpha", label: "Alpha" });
		await runtime.schemaRegistry.createCollection({ slug: "activation_beta", label: "Beta" });

		await expect(activateMediaUsageCapture(runtime.db, { writersDrained: true })).resolves.toEqual({
			outcome: "activating",
			processedCollections: 1,
			collectionCursor: "activation_alpha",
		});
		const confirmed = await activationState(runtime);

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "progress",
			continuation: { kind: "immediate" },
		});
		expect(await activationState(runtime)).toEqual(
			expect.objectContaining({
				state: "active",
				drain_confirmed_at: confirmed.drain_confirmed_at,
				attempt_count: confirmed.attempt_count + 1,
				last_error_code: null,
			}),
		);
	});

	it("does not automatically retry a stored activation failure", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await runtime.db
			.updateTable("_emdash_media_usage_activation")
			.set({
				state: "activating",
				drain_confirmed_at: "2026-08-18T12:00:00.000Z",
				last_error_code: "MEDIA_USAGE_ACTIVATION_FAILED",
			})
			.execute();
		const before = await activationState(runtime);

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "inactive",
			continuation: { kind: "none" },
		});
		expect(await activationState(runtime)).toEqual(before);

		await expect(activateMediaUsageCapture(runtime.db, { writersDrained: true })).resolves.toEqual({
			outcome: "active",
			processedCollections: 0,
		});
		expect(await activationState(runtime)).toEqual(
			expect.objectContaining({
				state: "active",
				attempt_count: before.attempt_count + 1,
				last_error_code: null,
			}),
		);
	});

	it("rejects an incompatible active generation before advancing maintenance", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await runtime.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "active", runtime_generation: 2 })
			.execute();
		const before = await activationState(runtime);

		await expect(runtime.runMediaUsageMaintenanceStep()).resolves.toEqual({
			state: "inactive",
			continuation: { kind: "none" },
		});
		expect(await activationState(runtime)).toEqual(before);
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

class ContinuousCapturingScheduler implements CronScheduler {
	private mediaUsageMaintenance: MediaUsageContinuationFn | null = null;
	wakeCount = 0;

	setSystemCleanup(_fn: SystemCleanupFn): void {}
	setContinuousMediaUsageMaintenance(fn: MediaUsageContinuationFn): void {
		this.mediaUsageMaintenance = fn;
	}
	wakeMediaUsageMaintenance(): void {
		this.wakeCount++;
	}

	start(): void {}
	stop(): void {}
	reschedule(): void {}

	async runContinuation() {
		if (!this.mediaUsageMaintenance) {
			throw new Error("Expected continuous Media Usage maintenance callback");
		}
		return this.mediaUsageMaintenance();
	}
}

function createDeps(createScheduler: RuntimeDependencies["createScheduler"]): RuntimeDependencies {
	return {
		config: {
			database: {
				entrypoint: `test-media-usage-scheduler-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		createScheduler,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

async function activateCollection(runtime: EmDashRuntime, collectionSlug: string) {
	await runtime.schemaRegistry.createCollection({ slug: collectionSlug, label: collectionSlug });
	await runtime.schemaRegistry.createField(collectionSlug, {
		slug: "title",
		label: "Title",
		type: "string",
	});
	const collection = await runtime.schemaRegistry.getCollection(collectionSlug);
	if (!collection) throw new Error(`Expected ${collectionSlug} collection`);

	await runtime.db
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
	await installMediaUsageCaptureTriggers(runtime.db, {
		collectionId: collection.id,
		collectionSlug,
	});
	await runtime.db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await runtime.db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
		.execute();

	return { collectionId: collection.id, tableName: `ec_${collectionSlug}` };
}

async function insertEntry(
	runtime: EmDashRuntime,
	tableName: string,
	contentId: string,
): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref(tableName)} (id, slug, status, title)
		VALUES (${contentId}, ${contentId}, 'published', ${contentId})
	`.execute(runtime.db);
}

async function countWork(runtime: EmDashRuntime): Promise<number> {
	const row = await runtime.db
		.selectFrom("_emdash_media_usage_work")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.executeTakeFirstOrThrow();
	return Number(row.count);
}

async function deletionPhase(runtime: EmDashRuntime, collectionId: string): Promise<string | null> {
	const row = await runtime.db
		.selectFrom("_emdash_media_usage_collection_deletions")
		.select("phase")
		.where("collection_id", "=", collectionId)
		.executeTakeFirst();
	return row?.phase ?? null;
}

function activationState(runtime: EmDashRuntime) {
	return runtime.db
		.selectFrom("_emdash_media_usage_activation")
		.selectAll()
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirstOrThrow();
}

function canonicalSourceKey(collectionId: string, contentId: string): string {
	return `content:${collectionId}:${contentId}:columns`;
}
