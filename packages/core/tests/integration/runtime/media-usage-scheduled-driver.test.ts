import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { sql, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaUsageWorkRepository } from "../../../src/database/repositories/media-usage-work.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { activateMediaUsageCapture } from "../../../src/media/usage/activation.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { runMediaUsageMaintenanceStep } from "../../../src/media/usage/maintenance-engine.js";
import { processDueMediaUsageReconciliation } from "../../../src/media/usage/reconciliation-processor.js";
import { processDueMediaUsageWork } from "../../../src/media/usage/work-processor.js";
import type { CronScheduler, SystemCleanupFn } from "../../../src/plugins/scheduler/types.js";
import { SCHEDULER_HEARTBEAT_OPTION } from "../../../src/scheduler-health.js";

describe("media usage maintenance engine and Node heartbeat", () => {
	let runtime: EmDashRuntime | null = null;

	afterEach(async () => {
		await runtime?.stopCron();
		runtime = null;
	});

	it("skips idle maintenance classes and processes due entry work", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "work_conserving_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
		});
		expect(await countWork(runtime)).toBe(1);
	});

	it("keeps a delayed continuation while collection deletion retry is waiting", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "delayed_deletion");
		await runtime.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: fixture.collectionId,
				collection_slug: "delayed_deletion",
				force_delete: 1,
				state: "retry",
				phase: "sources",
				next_attempt_at: "2100-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
		});
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toMatchObject({
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
		});
	});

	it("stops continuation only after a full idle maintenance pass", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await activateCollection(runtime, "idle_posts");

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
			state: "idle",
			continuation: { kind: "none" },
		});
	});

	it("continues reconciliation immediately after entry work drains", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		await configureExistingInactiveSite(runtime);
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toMatchObject({
			state: "progress",
			continuation: { kind: "immediate" },
		});
	});

	it("records a heartbeat from the Node timer maintenance callback", async () => {
		const scheduler = new ContinuousCapturingScheduler();
		runtime = await EmDashRuntime.create(createDeps(() => scheduler));

		await scheduler.runMaintenance();

		const heartbeat = await new OptionsRepository(runtime.db).get<string>(
			SCHEDULER_HEARTBEAT_OPTION,
		);
		expect(heartbeat).not.toBeNull();
		expect(Number.isNaN(Date.parse(heartbeat!))).toBe(false);
	});

	it("does not fail Node maintenance when the heartbeat write fails", async () => {
		const scheduler = new ContinuousCapturingScheduler();
		runtime = await EmDashRuntime.create(createDeps(() => scheduler));
		await new OptionsRepository(runtime.db).set(
			SCHEDULER_HEARTBEAT_OPTION,
			"2026-08-16T00:00:00.000Z",
		);
		await sql`
			CREATE TRIGGER fail_scheduler_heartbeat
			BEFORE UPDATE ON options
			WHEN NEW.name = ${sql.lit(SCHEDULER_HEARTBEAT_OPTION)}
			BEGIN
				SELECT RAISE(ABORT, 'heartbeat unavailable');
			END
		`.execute(runtime.db);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(scheduler.runMaintenance()).resolves.toBeUndefined();
		expect(consoleError).toHaveBeenCalledWith(
			"[scheduler] Failed to record heartbeat:",
			expect.anything(),
		);
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toMatchObject({
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

	it("finishes post-Ready collection deletion before declaring Ready again", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "reusable_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await processDueMediaUsageWork(runtime.db);

		await runtime.schemaRegistry.deleteCollection("reusable_posts", { force: true });
		expect(await deletionPhase(runtime, fixture.collectionId)).toBe("work");
		await expect(new MediaUsageRepository(runtime.db).findCollectionProgress()).resolves.toEqual({
			status: "indexing",
			readyCollections: 0,
			totalCollections: 0,
		});

		for (let step = 0; step < 10 && (await deletionPhase(runtime, fixture.collectionId)); step++) {
			await runMediaUsageMaintenanceStep(runtime.db);
		}

		expect(await deletionPhase(runtime, fixture.collectionId)).toBeNull();
		await expect(
			runtime.schemaRegistry.createCollection({ slug: "reusable_posts", label: "Reusable posts" }),
		).resolves.toMatchObject({ slug: "reusable_posts" });
	});

	it("resumes historical reconciliation after failed entry work is retried", async () => {
		runtime = await EmDashRuntime.create(createDeps(null));
		const fixture = await activateCollection(runtime, "retry_posts");
		await insertEntry(runtime, fixture.tableName, "entry-1");
		await sql`DELETE FROM ${sql.ref(fixture.tableName)} WHERE id = 'entry-1'`.execute(runtime.db);
		await runtime.db
			.updateTable("_emdash_media_usage_work")
			.set({ state: "failed", attempt_count: 5, last_error_code: "MEDIA_USAGE_PROCESSING_FAILED" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await runtime.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				status: "running",
				completed_at: null,
				cursor: "failed-run",
				change_epoch: 1,
				reconciliation_required: 1,
				last_error_code: "MEDIA_USAGE_PROCESSING_FAILED",
			})
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await runtime.db
			.insertInto("_emdash_media_usage_reconciliations")
			.values({
				collection_id: fixture.collectionId,
				collection_slug: "retry_posts",
				run_token: "failed-run",
				target_epoch: 1,
				state: "failed",
				phase: "sources",
				attempt_count: 5,
				last_error_code: "MEDIA_USAGE_RECONCILIATION_ENTRY_FAILED",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();

		await expect(
			new MediaUsageWorkRepository(runtime.db).retryOperatorWork({
				collectionId: fixture.collectionId,
				contentId: "entry-1",
			}),
		).resolves.toMatchObject({ outcome: "pending", changed: true });
		await expect(
			new MediaUsageRepository(runtime.db).findCollectionProgress(),
		).resolves.toMatchObject({
			status: "indexing",
		});

		for (let step = 0; step < 12; step++) {
			const progress = await new MediaUsageRepository(runtime.db).findCollectionProgress();
			if (progress?.status === "ready") break;
			await runMediaUsageMaintenanceStep(runtime.db);
		}
		await expect(
			new MediaUsageRepository(runtime.db).findCollectionProgress(),
		).resolves.toMatchObject({
			status: "ready",
		});
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
		await configureExistingInactiveSite(runtime);
		await runtime.schemaRegistry.createCollection({ slug: "activation_alpha", label: "Alpha" });
		await runtime.schemaRegistry.createCollection({ slug: "activation_beta", label: "Beta" });

		await expect(activateMediaUsageCapture(runtime.db, { writersDrained: true })).resolves.toEqual({
			outcome: "activating",
			processedCollections: 1,
			collectionCursor: "activation_alpha",
		});
		const confirmed = await activationState(runtime);

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
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

		await expect(runMediaUsageMaintenanceStep(runtime.db)).resolves.toEqual({
			state: "inactive",
			continuation: { kind: "none" },
		});
		expect(await activationState(runtime)).toEqual(before);
	});
});

class ContinuousCapturingScheduler implements CronScheduler {
	private systemCleanup: SystemCleanupFn | null = null;

	setSystemCleanup(fn: SystemCleanupFn): void {
		this.systemCleanup = fn;
	}

	start(): void {}
	stop(): void {}
	reschedule(): void {}

	async runMaintenance(): Promise<void> {
		if (!this.systemCleanup) throw new Error("Expected Node maintenance callback");
		await this.systemCleanup();
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

async function configureExistingInactiveSite(runtime: EmDashRuntime): Promise<void> {
	await new OptionsRepository(runtime.db).set("emdash:setup_complete", true);
	await runtime.db
		.updateTable("_emdash_media_usage_activation")
		.set({
			state: "expanded",
			collection_cursor: null,
			drain_confirmed_at: null,
			lease_token: null,
			lease_expires_at: null,
			attempt_count: 0,
			last_attempted_at: null,
			last_error_code: null,
			activated_at: null,
		})
		.where("task_key", "=", "incremental_capture")
		.execute();
}

function canonicalSourceKey(collectionId: string, contentId: string): string {
	return `content:${collectionId}:${contentId}:columns`;
}
