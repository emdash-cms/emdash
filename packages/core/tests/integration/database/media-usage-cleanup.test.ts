import { sql, type Kysely, type Transaction } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runSystemCleanup } from "../../../src/cleanup.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database } from "../../../src/database/types.js";
import {
	cleanupMediaUsage,
	MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT,
	MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
	MEDIA_USAGE_CLEANUP_INTERVAL_MS,
} from "../../../src/media/usage/cleanup.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const MAX_CLEANUP_ADMISSION_TIME_MS = 5_000;

describeEachDialect("scheduled media usage cleanup", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let repo: MediaUsageRepository;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date());
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		repo = new MediaUsageRepository(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		await teardownForDialect(ctx);
	});

	it("reclaims every superseded generation class through production maintenance", async () => {
		const first = await repo.replaceSource(contentSource("entry-1"), [occurrence("media-stale")]);
		const current = await repo.replaceSource(contentSource("entry-1"), [
			occurrence("media-current"),
		]);

		await db
			.updateTable("_emdash_media_usage_sources")
			.set({ indexed_at: "2026-02-01T20:00:00.000Z" })
			.where("source_key", "=", current.sourceKey)
			.execute();
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", first.currentGeneration)
			.execute();
		await insertOccurrence(db, {
			id: "abandoned-occurrence",
			sourceKey: current.sourceKey,
			generation: "abandoned-generation",
			mediaId: "media-abandoned",
			createdAt: "2026-02-01T21:00:00.000Z",
		});
		await insertOccurrence(db, {
			id: "orphan-occurrence",
			sourceKey: "missing-source",
			generation: "orphan-generation",
			mediaId: "media-orphan",
			createdAt: "2026-02-01T18:00:00.000Z",
		});

		await runSystemCleanup(db);

		const remaining = await db
			.selectFrom("_emdash_media_usage")
			.select(["id", "generation", "media_id"])
			.orderBy("id", "asc")
			.execute();
		expect(remaining).toEqual([
			expect.objectContaining({
				generation: current.currentGeneration,
				media_id: "media-current",
			}),
		]);
	});

	it("admits only one overlapping tick to the shared delete budget", async () => {
		const stale = await repo.replaceSource(
			contentSource("entry-overlap"),
			Array.from({ length: MEDIA_USAGE_CLEANUP_DELETE_LIMIT + 20 }, (_, index) =>
				occurrence(`media-stale-${index}`, `field-${index}`),
			),
		);
		await repo.replaceSource(contentSource("entry-overlap"), [occurrence("media-current")]);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", stale.currentGeneration)
			.execute();

		const results = await Promise.all([cleanupMediaUsage(db), cleanupMediaUsage(db)]);

		expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
		expect(results.filter((result) => result.status === "skipped")).toHaveLength(1);
		const remaining = await db
			.selectFrom("_emdash_media_usage")
			.select(({ fn }) => fn.countAll<number>().as("count"))
			.where("generation", "=", stale.currentGeneration)
			.executeTakeFirstOrThrow();
		expect(Number(remaining.count)).toBe(20);
	});

	it("does not let a fast scheduler clock steal an active cleanup lease", async () => {
		const owner = await repo.claimMediaUsageCleanup({
			leaseToken: "database-clock-owner",
			leaseDurationSeconds: 5 * 60,
			nextEligibleDelaySeconds: 60,
			sweepSafetyWindowSeconds: 60 * 60,
		});
		expect(owner).not.toBeNull();

		vi.advanceTimersByTime(6 * 60 * 1000);
		const stolen = await repo.claimMediaUsageCleanup({
			leaseToken: "fast-scheduler",
			leaseDurationSeconds: 5 * 60,
			nextEligibleDelaySeconds: 60,
			sweepSafetyWindowSeconds: 60 * 60,
		});

		expect(stolen).toBeNull();
	});

	it("advances a bounded cursor past old live rows to later garbage", async () => {
		const stale = await repo.replaceSource(
			contentSource("entry-cursor"),
			Array.from({ length: 5 }, (_, index) =>
				occurrence(`media-stale-cursor-${index}`, `stale-${index}`),
			),
		);
		const current = await repo.replaceSource(
			contentSource("entry-cursor"),
			Array.from({ length: MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT }, (_, index) =>
				occurrence(`media-current-cursor-${index}`, `current-${index}`),
			),
		);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", current.currentGeneration)
			.execute();
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:10:00.000Z" })
			.where("generation", "=", stale.currentGeneration)
			.execute();

		const first = await cleanupMediaUsage(db);
		expect(first).toEqual(
			expect.objectContaining({
				status: "completed",
				candidateRows: MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT,
				deletedRows: 0,
				scanHasMore: true,
			}),
		);

		await makeCleanupEligible(db);
		const second = await cleanupMediaUsage(db);
		expect(second).toEqual(expect.objectContaining({ status: "completed", deletedRows: 5 }));
		expect(
			await db
				.selectFrom("_emdash_media_usage")
				.select("id")
				.where("generation", "=", stale.currentGeneration)
				.execute(),
		).toEqual([]);
	});

	it("restarts a finite sweep before later work can strand newly stale rows", async () => {
		const head = await repo.replaceSource(
			contentSource("entry-sweep-head"),
			Array.from({ length: MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT }, (_, index) =>
				occurrence(`media-sweep-head-${index}`, `head-${index}`),
			),
		);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", head.currentGeneration)
			.execute();

		expect((await cleanupMediaUsage(db)).candidateRows).toBe(MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT);
		const firstSweep = await db
			.selectFrom("_emdash_media_usage_cleanup")
			.select("scan_before_at")
			.where("task_key", "=", "projection_gc")
			.executeTakeFirstOrThrow();
		expect(firstSweep.scan_before_at).not.toBeNull();

		await repo.replaceSource(contentSource("entry-sweep-head"), [
			occurrence("media-sweep-current"),
		]);
		vi.advanceTimersByTime(30 * 60 * 1000);
		const laterCreatedAt = new Date(
			Date.parse(firstSweep.scan_before_at!) + 15 * 60 * 1000,
		).toISOString();
		for (let index = 0; index < MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT; index += 1) {
			await insertOccurrence(db, {
				id: `sweep-later-${index}`,
				sourceKey: `sweep-later-source-${index}`,
				generation: `01K00000000000000000${String(index).padStart(3, "0")}`,
				mediaId: `media-sweep-later-${index}`,
				createdAt: laterCreatedAt,
			});
		}

		await makeCleanupEligible(db);
		expect(await cleanupMediaUsage(db)).toEqual(
			expect.objectContaining({ candidateRows: 0, scanHasMore: false }),
		);
		await makeCleanupEligible(db);
		expect((await cleanupMediaUsage(db)).deletedRows).toBe(MEDIA_USAGE_CLEANUP_DELETE_LIMIT);
	});

	it("backs off after a failed tick and retries from the persisted state", async () => {
		const source = await repo.replaceSource(contentSource("entry-failure"), [
			occurrence("media-before-failure"),
		]);
		await repo.replaceSource(contentSource("entry-failure"), [occurrence("media-current")]);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", source.currentGeneration)
			.execute();

		vi.spyOn(
			MediaUsageRepository.prototype,
			"findMediaUsageCleanupCandidates",
		).mockImplementationOnce(async function (this: MediaUsageRepository, input) {
			await Promise.resolve();
			throw new Error(`cleanup candidate failure at ${input.cutoff}`);
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const failed = await cleanupMediaUsage(db);
		expect(failed.status).toBe("failed");
		const failureState = await db
			.selectFrom("_emdash_media_usage_cleanup")
			.select(["next_eligible_at", "consecutive_failures", "last_error_code"])
			.where("task_key", "=", "projection_gc")
			.executeTakeFirstOrThrow();
		expect(failureState).toEqual(
			expect.objectContaining({
				consecutive_failures: 1,
				last_error_code: "MEDIA_USAGE_CLEANUP_FAILED",
			}),
		);
		expect(Date.parse(failureState.next_eligible_at)).toBeGreaterThan(Date.now());

		expect((await cleanupMediaUsage(db)).status).toBe("skipped");
		await makeCleanupEligible(db);
		expect((await cleanupMediaUsage(db)).deletedRows).toBe(1);
	});

	it("does not admit another cleanup statement after its time budget expires", async () => {
		const stale = await repo.replaceSource(contentSource("entry-time-budget"), [
			occurrence("media-before-time-budget"),
		]);
		await repo.replaceSource(contentSource("entry-time-budget"), [occurrence("media-current")]);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", stale.currentGeneration)
			.execute();

		const original = MediaUsageRepository.prototype.findMediaUsageCleanupCandidates;
		vi.spyOn(MediaUsageRepository.prototype, "findMediaUsageCleanupCandidates").mockImplementation(
			async function (this: MediaUsageRepository, input) {
				const candidates = await original.call(this, input);
				vi.advanceTimersByTime(MAX_CLEANUP_ADMISSION_TIME_MS);
				return candidates;
			},
		);

		const result = await cleanupMediaUsage(db);
		expect(result).toEqual(
			expect.objectContaining({
				candidateRows: 1,
				deletedRows: 0,
				durationMs: MAX_CLEANUP_ADMISSION_TIME_MS,
			}),
		);
		expect(
			await db
				.selectFrom("_emdash_media_usage")
				.select("id")
				.where("generation", "=", stale.currentGeneration)
				.execute(),
		).toHaveLength(1);
	});

	it("protects an active writer lease and reclaims its abandoned generation after expiry", async () => {
		const stale = await repo.replaceSource(contentSource("entry-writer-lease"), [
			occurrence("media-stale-writer"),
		]);
		await repo.replaceSource(contentSource("entry-writer-lease"), [occurrence("media-current")]);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", stale.currentGeneration)
			.execute();
		await db
			.insertInto("_emdash_media_usage_generation_writes")
			.values({
				source_key: stale.sourceKey,
				generation: stale.currentGeneration,
				lease_token: "active-writer-lease",
				expires_at: new Date(Date.now() + 60 * MEDIA_USAGE_CLEANUP_INTERVAL_MS).toISOString(),
				created_at: new Date().toISOString(),
			})
			.execute();

		expect((await cleanupMediaUsage(db)).deletedRows).toBe(0);
		expect(
			await db
				.selectFrom("_emdash_media_usage")
				.select("id")
				.where("generation", "=", stale.currentGeneration)
				.execute(),
		).toHaveLength(1);

		await db
			.updateTable("_emdash_media_usage_generation_writes")
			.set({ expires_at: "1970-01-01T00:00:00.000Z" })
			.where("lease_token", "=", "active-writer-lease")
			.execute();
		await makeCleanupEligible(db);
		const reclaimed = await cleanupMediaUsage(db);
		expect(reclaimed).toEqual(expect.objectContaining({ deletedRows: 1, deletedWriteLeases: 1 }));
	});
	it("derives generation-write and occurrence timestamps from database time", async () => {
		vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
		let expiresAt: string | undefined;
		let occurrenceCreatedAt: string | undefined;
		const internals = repo as unknown as {
			upsertSource(
				transaction: Kysely<Database> | Transaction<Database>,
				source: unknown,
				generation: string,
				now: string,
				leaseToken: string,
			): Promise<boolean>;
		};
		const original = internals.upsertSource.bind(repo);
		vi.spyOn(internals, "upsertSource").mockImplementation(
			async (transaction, source, generation, now, leaseToken) => {
				const [writeLease, storedOccurrence] = await Promise.all([
					transaction
						.selectFrom("_emdash_media_usage_generation_writes")
						.select("expires_at")
						.where("lease_token", "=", leaseToken)
						.executeTakeFirstOrThrow(),
					transaction
						.selectFrom("_emdash_media_usage")
						.select("created_at")
						.where("generation", "=", generation)
						.executeTakeFirstOrThrow(),
				]);
				expiresAt = writeLease.expires_at;
				occurrenceCreatedAt = storedOccurrence.created_at;
				return original(transaction, source, generation, now, leaseToken);
			},
		);

		await repo.replaceSource(contentSource("entry-database-writer-clock"), [
			occurrence("media-database-writer-clock"),
		]);

		const databaseNow = await databaseNowTimestamp(db, dialect);
		const remainingMs = Date.parse(expiresAt!) - Date.parse(databaseNow);
		expect(remainingMs).toBeGreaterThan(59 * 60 * 1000);
		expect(remainingMs).toBeLessThan(61 * 60 * 1000);
		const occurrenceAgeMs = Date.parse(occurrenceCreatedAt!) - Date.parse(databaseNow);
		expect(occurrenceAgeMs).toBeGreaterThan(-60_000);
		expect(occurrenceAgeMs).toBeLessThan(60_000);
	});

	it("fences a pre-lease writer after cleanup reclaims its generation", async () => {
		const current = await repo.replaceSource(contentSource("entry-old-writer"), [
			occurrence("media-current"),
		]);
		const oldGeneration = "01J00000000000000000000000";
		await insertOccurrence(db, {
			id: "old-writer-occurrence",
			sourceKey: current.sourceKey,
			generation: oldGeneration,
			mediaId: "media-old-writer",
			createdAt: "2026-02-01T19:00:00.000Z",
		});

		expect((await cleanupMediaUsage(db)).deletedRows).toBe(1);
		expect(
			await db
				.selectFrom("_emdash_media_usage_cleanup_fence")
				.select("generation_floor")
				.where("task_key", "=", "projection_gc")
				.executeTakeFirstOrThrow(),
		).toEqual({ generation_floor: oldGeneration });

		const promotion = await db
			.updateTable("_emdash_media_usage_sources")
			.set({ current_generation: oldGeneration })
			.where("source_key", "=", current.sourceKey)
			.executeTakeFirst();
		expect(Number(promotion.numUpdatedRows ?? 0)).toBe(0);
		expect(await repo.findCurrentUsageByMediaId("media-current")).toHaveLength(1);
	});

	it("does not advance the promotion fence when normal source deletion removes a cleanup-marked occurrence", async () => {
		const current = await repo.replaceSource(contentSource("entry-normal-delete"), [
			occurrence("media-normal-delete"),
		]);
		expect(
			await repo.claimMediaUsageCleanup({
				leaseToken: "normal-delete-cleanup-owner",
				leaseDurationSeconds: 5 * 60,
				nextEligibleDelaySeconds: 60,
				sweepSafetyWindowSeconds: 60 * 60,
			}),
		).not.toBeNull();
		await db
			.updateTable("_emdash_media_usage")
			.set({ cleanup_lease_token: "normal-delete-cleanup-owner" })
			.where("source_key", "=", current.sourceKey)
			.execute();

		expect(await repo.deleteSource(current.sourceKey)).toBe(1);
		expect(await db.selectFrom("_emdash_media_usage_cleanup_fence").selectAll().execute()).toEqual(
			[],
		);
	});

	it("allows attempt-only sources behind the cleanup generation fence", async () => {
		await db
			.insertInto("_emdash_media_usage_cleanup_fence")
			.values({ task_key: "projection_gc", generation_floor: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ" })
			.execute();

		const attempted = await repo.markSourceAttempted({
			...contentSource("entry-attempt-only"),
			lastErrorCode: "MEDIA_USAGE_INDEX_FAILED",
		});
		const guarded = await repo.markSourceAttemptedIfMatching(
			{
				...contentSource("entry-guarded-attempt-only"),
				lastErrorCode: "MEDIA_USAGE_INDEX_FAILED",
			},
			null,
		);

		expect(attempted.sourceKey).toBe("content:posts:entry-attempt-only:columns");
		expect(attempted.lastErrorCode).toBe("MEDIA_USAGE_INDEX_FAILED");
		expect(guarded).toEqual({ attempted: true, source: null });
		expect(
			await repo.findSource("content:posts:entry-guarded-attempt-only:columns"),
		).not.toBeNull();
		expect(
			await db
				.selectFrom("_emdash_media_usage")
				.select("id")
				.where("source_key", "in", [
					attempted.sourceKey,
					"content:posts:entry-guarded-attempt-only:columns",
				])
				.execute(),
		).toEqual([]);
	});

	it("allows unrelated PostgreSQL source writes to overlap", async () => {
		if (dialect !== "postgres") return;

		let releaseFirst!: () => void;
		const firstRelease = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let signalFirstInserted!: () => void;
		const firstInserted = new Promise<void>((resolve) => {
			signalFirstInserted = resolve;
		});
		const first = db.transaction().execute(async (trx) => {
			await trx
				.insertInto("_emdash_media_usage_sources")
				.values({
					source_key: "concurrent-source-a",
					source_type: "content",
					source_variant: "columns",
					current_generation: "concurrent-generation-a",
				})
				.execute();
			signalFirstInserted();
			await firstRelease;
		});
		await firstInserted;

		let secondError: unknown;
		try {
			await db.transaction().execute(async (trx) => {
				await sql`SET LOCAL lock_timeout = '250ms'`.execute(trx);
				await trx
					.insertInto("_emdash_media_usage_sources")
					.values({
						source_key: "concurrent-source-b",
						source_type: "content",
						source_variant: "columns",
						current_generation: "concurrent-generation-b",
					})
					.execute();
			});
		} catch (error) {
			secondError = error;
		}
		releaseFirst();
		await first;

		expect(secondError).toBeUndefined();
	});

	it("allows an unrelated PostgreSQL source write during source deletion", async () => {
		if (dialect !== "postgres") return;

		const current = await repo.replaceSource(contentSource("entry-concurrent-delete"), [
			occurrence("media-concurrent-delete"),
		]);
		const internals = repo as unknown as {
			deleteSourceGenerationOccurrences(
				database: Kysely<Database> | Transaction<Database>,
				sourceKey: string,
				generation: string,
			): Promise<void>;
		};
		const original = internals.deleteSourceGenerationOccurrences.bind(repo);
		let releaseDelete!: () => void;
		const deleteRelease = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		let signalDeleteStarted!: () => void;
		const deleteStarted = new Promise<void>((resolve) => {
			signalDeleteStarted = resolve;
		});
		vi.spyOn(internals, "deleteSourceGenerationOccurrences").mockImplementation(
			async (database, sourceKey, generation) => {
				signalDeleteStarted();
				await deleteRelease;
				return original(database, sourceKey, generation);
			},
		);
		const deleting = repo.deleteSourceIfCurrent(current.sourceKey, current.currentGeneration);
		await deleteStarted;

		let sourceWriteError: unknown;
		try {
			await db.transaction().execute(async (trx) => {
				await sql`SET LOCAL lock_timeout = '250ms'`.execute(trx);
				await trx
					.insertInto("_emdash_media_usage_sources")
					.values({
						source_key: "source-during-delete",
						source_type: "content",
						source_variant: "columns",
						current_generation: "generation-during-delete",
					})
					.execute();
			});
		} catch (error) {
			sourceWriteError = error;
		}
		releaseDelete();

		expect(await deleting).toEqual({ deleted: true, source: null });
		expect(sourceWriteError).toBeUndefined();
	});

	it("makes PostgreSQL cleanup wait for an in-flight source write", async () => {
		if (dialect !== "postgres") return;

		let releaseSourceWrite!: () => void;
		const sourceWriteRelease = new Promise<void>((resolve) => {
			releaseSourceWrite = resolve;
		});
		let signalSourceInserted!: () => void;
		const sourceInserted = new Promise<void>((resolve) => {
			signalSourceInserted = resolve;
		});
		const writing = db.transaction().execute(async (trx) => {
			await trx
				.insertInto("_emdash_media_usage_sources")
				.values({
					source_key: "cleanup-fence-source",
					source_type: "content",
					source_variant: "columns",
					current_generation: "cleanup-fence-generation",
				})
				.execute();
			signalSourceInserted();
			await sourceWriteRelease;
		});
		await sourceInserted;

		let claimError: unknown;
		try {
			await db.transaction().execute(async (trx) => {
				await sql`SET LOCAL lock_timeout = '250ms'`.execute(trx);
				await new MediaUsageRepository(trx).claimMediaUsageCleanup({
					leaseToken: "blocked-source-write-claimant",
					leaseDurationSeconds: 5 * 60,
					nextEligibleDelaySeconds: 60,
					sweepSafetyWindowSeconds: 60 * 60,
				});
			});
		} catch (error) {
			claimError = error;
		}
		releaseSourceWrite();
		await writing;
		const claim = await repo.claimMediaUsageCleanup({
			leaseToken: "source-write-claimant",
			leaseDurationSeconds: 5 * 60,
			nextEligibleDelaySeconds: 60,
			sweepSafetyWindowSeconds: 60 * 60,
		});

		expect(claimError).toMatchObject({ code: "55P03" });
		expect(claim).not.toBeNull();
	});

	it("takes the PostgreSQL cleanup lock before source deletion locks occurrences", async () => {
		if (dialect !== "postgres") return;

		const current = await repo.replaceSource(contentSource("entry-delete-lock-order"), [
			occurrence("media-delete-lock-order"),
		]);
		expect(
			await repo.claimMediaUsageCleanup({
				leaseToken: "delete-lock-order-owner",
				leaseDurationSeconds: 5 * 60,
				nextEligibleDelaySeconds: 60,
				sweepSafetyWindowSeconds: 60 * 60,
			}),
		).not.toBeNull();
		await db
			.updateTable("_emdash_media_usage")
			.set({ cleanup_lease_token: "delete-lock-order-owner" })
			.where("source_key", "=", current.sourceKey)
			.execute();

		let releaseCleanupLock!: () => void;
		const cleanupLockRelease = new Promise<void>((resolve) => {
			releaseCleanupLock = resolve;
		});
		let signalCleanupLockAcquired!: () => void;
		const cleanupLockAcquired = new Promise<void>((resolve) => {
			signalCleanupLockAcquired = resolve;
		});
		const cleanupLockHolder = db.transaction().execute(async (trx) => {
			await sql`
				SELECT 1
				FROM _emdash_media_usage_cleanup
				WHERE task_key = 'projection_gc'
				FOR UPDATE
			`.execute(trx);
			signalCleanupLockAcquired();
			await cleanupLockRelease;
		});
		await cleanupLockAcquired;

		let deletionFinished = false;
		const deleting = repo.deleteSource(current.sourceKey).then((deleted) => {
			deletionFinished = true;
			return deleted;
		});
		await sql`SELECT pg_sleep(0.1)`.execute(db);
		const finishedWhileCleanupLockHeld = deletionFinished;
		releaseCleanupLock();

		expect(await deleting).toBe(1);
		await cleanupLockHolder;
		expect(finishedWhileCleanupLockHeld).toBe(false);
	});

	it("serializes previous-version PostgreSQL source deletion at the cleanup singleton", async () => {
		if (dialect !== "postgres") return;

		const current = await repo.replaceSource(contentSource("entry-old-delete-lock-order"), [
			occurrence("media-old-delete-lock-order"),
		]);
		expect(
			await repo.claimMediaUsageCleanup({
				leaseToken: "old-delete-lock-order-owner",
				leaseDurationSeconds: 5 * 60,
				nextEligibleDelaySeconds: 60,
				sweepSafetyWindowSeconds: 60 * 60,
			}),
		).not.toBeNull();
		await db
			.updateTable("_emdash_media_usage")
			.set({ cleanup_lease_token: "old-delete-lock-order-owner" })
			.where("source_key", "=", current.sourceKey)
			.execute();

		let releaseCleanupLock!: () => void;
		const cleanupLockRelease = new Promise<void>((resolve) => {
			releaseCleanupLock = resolve;
		});
		let signalCleanupLockAcquired!: () => void;
		const cleanupLockAcquired = new Promise<void>((resolve) => {
			signalCleanupLockAcquired = resolve;
		});
		const cleanupLockHolder = db.transaction().execute(async (trx) => {
			await sql`
				SELECT 1
				FROM _emdash_media_usage_cleanup
				WHERE task_key = 'projection_gc'
				FOR UPDATE
			`.execute(trx);
			signalCleanupLockAcquired();
			await cleanupLockRelease;
		});
		await cleanupLockAcquired;

		let deletionFinished = false;
		const deleting = db
			.transaction()
			.execute(async (trx) => {
				await trx
					.deleteFrom("_emdash_media_usage_sources")
					.where("source_key", "=", current.sourceKey)
					.execute();
				await trx
					.deleteFrom("_emdash_media_usage")
					.where("source_key", "=", current.sourceKey)
					.execute();
			})
			.then(() => {
				deletionFinished = true;
				return true;
			});
		await sql`SELECT pg_sleep(0.1)`.execute(db);
		const finishedWhileCleanupLockHeld = deletionFinished;
		releaseCleanupLock();

		await Promise.all([deleting, cleanupLockHolder]);
		expect(finishedWhileCleanupLockHeld).toBe(false);
	});

	it("takes the PostgreSQL cleanup lock before source promotion locks the source row", async () => {
		if (dialect !== "postgres") return;

		const current = await repo.replaceSource(contentSource("entry-promotion-lock-order"), [
			occurrence("media-before-promotion-lock"),
		]);
		let signalCleanupLockAcquired!: () => void;
		const cleanupLockAcquired = new Promise<void>((resolve) => {
			signalCleanupLockAcquired = resolve;
		});
		let startSourceDelete!: () => void;
		const sourceDeleteStart = new Promise<void>((resolve) => {
			startSourceDelete = resolve;
		});
		const deleting = db.transaction().execute(async (trx) => {
			await sql`
				SELECT 1
				FROM _emdash_media_usage_cleanup
				WHERE task_key = 'projection_gc'
				FOR UPDATE
			`.execute(trx);
			signalCleanupLockAcquired();
			await sourceDeleteStart;
			return trx
				.deleteFrom("_emdash_media_usage_sources")
				.where("source_key", "=", current.sourceKey)
				.executeTakeFirst();
		});
		await cleanupLockAcquired;

		const replacing = repo.replaceSourceIfCurrent(
			contentSource("entry-promotion-lock-order"),
			[occurrence("media-after-promotion-lock")],
			current.currentGeneration,
		);
		await sql`SELECT pg_sleep(0.1)`.execute(db);
		startSourceDelete();
		const outcomes = await Promise.allSettled([deleting, replacing]);

		expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
		if (outcomes[1]?.status === "fulfilled") {
			expect(outcomes[1].value.replaced).toBe(false);
		}
	});

	it("uses database time to reject delayed cleanup work after claim expiry", async () => {
		const stale = await repo.replaceSource(contentSource("entry-delayed-cleanup"), [
			occurrence("media-before-expiry"),
		]);
		await repo.replaceSource(contentSource("entry-delayed-cleanup"), [occurrence("media-current")]);
		const staleOccurrence = await db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("generation", "=", stale.currentGeneration)
			.executeTakeFirstOrThrow();
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("id", "=", staleOccurrence.id)
			.execute();
		await db
			.updateTable("_emdash_media_usage_cleanup")
			.set({
				lease_token: "delayed-owner",
				lease_expires_at: new Date(Date.now() - 1).toISOString(),
			})
			.where("task_key", "=", "projection_gc")
			.execute();

		const delayedLease = { leaseToken: "delayed-owner" };
		const deleted = await repo.deleteStaleGenerationsOlderThan(
			new Date(Date.now() + MEDIA_USAGE_CLEANUP_INTERVAL_MS).toISOString(),
			1,
			{
				candidateIds: [staleOccurrence.id],
				cleanupLease: delayedLease,
			},
		);

		expect(deleted).toBe(0);
		expect(
			await db
				.selectFrom("_emdash_media_usage")
				.select("id")
				.where("id", "=", staleOccurrence.id)
				.executeTakeFirst(),
		).not.toBeNull();
	});

	it("blocks a post-expiry claimant until an in-flight PostgreSQL delete completes", async () => {
		if (dialect !== "postgres") return;

		const stale = await repo.replaceSource(contentSource("entry-postgres-delete-lock"), [
			occurrence("media-before-delete-lock"),
		]);
		await repo.replaceSource(contentSource("entry-postgres-delete-lock"), [
			occurrence("media-current-delete-lock"),
		]);
		const staleOccurrence = await db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("generation", "=", stale.currentGeneration)
			.executeTakeFirstOrThrow();
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("id", "=", staleOccurrence.id)
			.execute();
		await sql`
			CREATE FUNCTION test_media_usage_cleanup_delete_delay()
			RETURNS trigger AS $$
			BEGIN
				PERFORM pg_sleep(0.8);
				RETURN OLD;
			END;
			$$ LANGUAGE plpgsql
		`.execute(db);
		await sql`
			CREATE TRIGGER test_media_usage_cleanup_delete_delay
			BEFORE DELETE ON _emdash_media_usage
			FOR EACH ROW EXECUTE FUNCTION test_media_usage_cleanup_delete_delay()
		`.execute(db);

		const owner = await repo.claimMediaUsageCleanup({
			leaseToken: "delete-lock-owner",
			leaseDurationSeconds: 5 * 60,
			nextEligibleDelaySeconds: 60,
			sweepSafetyWindowSeconds: 60 * 60,
		});
		expect(owner).not.toBeNull();
		await sql`
			UPDATE _emdash_media_usage_cleanup
			SET lease_expires_at = to_char(
				(clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '100 milliseconds',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			), next_eligible_at = '1970-01-01T00:00:00.000Z'
			WHERE task_key = 'projection_gc'
		`.execute(db);

		const deleting = repo.deleteStaleGenerationsOlderThan("2100-01-01T00:00:00.000Z", 1, {
			candidateIds: [staleOccurrence.id],
			cleanupLease: { leaseToken: "delete-lock-owner" },
		});
		await sql`SELECT pg_sleep(0.2)`.execute(db);
		let claimedBeforeDeleteFinished = false;
		const nextClaim = repo
			.claimMediaUsageCleanup({
				leaseToken: "post-expiry-claimant",
				leaseDurationSeconds: 5 * 60,
				nextEligibleDelaySeconds: 60,
				sweepSafetyWindowSeconds: 60 * 60,
			})
			.then((claim) => {
				claimedBeforeDeleteFinished = true;
				return claim;
			});
		await sql`SELECT pg_sleep(0.2)`.execute(db);

		expect(claimedBeforeDeleteFinished).toBe(false);
		expect(await deleting).toBe(1);
		expect(await nextClaim).not.toBeNull();
		expect(
			await db
				.selectFrom("_emdash_media_usage_cleanup_fence")
				.select("generation_floor")
				.where("task_key", "=", "projection_gc")
				.executeTakeFirstOrThrow(),
		).toEqual({ generation_floor: stale.currentGeneration });
		const promotion = await db
			.updateTable("_emdash_media_usage_sources")
			.set({ current_generation: stale.currentGeneration })
			.where("source_key", "=", stale.sourceKey)
			.executeTakeFirst();
		expect(Number(promotion.numUpdatedRows ?? 0)).toBe(0);
	});

	it("stops deletion when a newer cleanup owner takes the lease", async () => {
		const stale = await repo.replaceSource(contentSource("entry-cleanup-takeover"), [
			occurrence("media-stale"),
		]);
		await repo.replaceSource(contentSource("entry-cleanup-takeover"), [
			occurrence("media-current"),
		]);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", stale.currentGeneration)
			.execute();

		const original = MediaUsageRepository.prototype.deleteStaleGenerationsOlderThan;
		vi.spyOn(MediaUsageRepository.prototype, "deleteStaleGenerationsOlderThan").mockImplementation(
			async function (this: MediaUsageRepository, cutoff, limit, options) {
				await db
					.updateTable("_emdash_media_usage_cleanup")
					.set({ lease_token: "newer-owner", lease_expires_at: "2026-02-02T00:05:00.000Z" })
					.where("task_key", "=", "projection_gc")
					.execute();
				return original.call(this, cutoff, limit, options);
			},
		);

		expect((await cleanupMediaUsage(db)).deletedRows).toBe(0);
		expect(
			await db
				.selectFrom("_emdash_media_usage")
				.select("id")
				.where("generation", "=", stale.currentGeneration)
				.execute(),
		).toHaveLength(1);
	});

	it("revalidates a candidate when concurrent publication makes it current", async () => {
		const stale = await repo.replaceSource(contentSource("entry-publication-race"), [
			occurrence("media-before-publication"),
		]);
		await repo.replaceSource(contentSource("entry-publication-race"), [
			occurrence("media-after-publication"),
		]);
		await db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-02-01T19:00:00.000Z" })
			.where("generation", "=", stale.currentGeneration)
			.execute();

		const original = MediaUsageRepository.prototype.deleteStaleGenerationsOlderThan;
		vi.spyOn(MediaUsageRepository.prototype, "deleteStaleGenerationsOlderThan").mockImplementation(
			async function (this: MediaUsageRepository, cutoff, limit, options) {
				await db
					.updateTable("_emdash_media_usage_sources")
					.set({ current_generation: stale.currentGeneration })
					.where("source_key", "=", stale.sourceKey)
					.execute();
				return original.call(this, cutoff, limit, options);
			},
		);

		expect((await cleanupMediaUsage(db)).deletedRows).toBe(0);
		expect(await repo.findCurrentUsageByMediaId("media-before-publication")).toHaveLength(1);
	});

	it("does not report completion after its cleanup claim is fenced by a newer owner", async () => {
		const original = MediaUsageRepository.prototype.completeMediaUsageCleanup;
		vi.spyOn(MediaUsageRepository.prototype, "completeMediaUsageCleanup").mockImplementation(
			async function (this: MediaUsageRepository, input) {
				await db
					.updateTable("_emdash_media_usage_cleanup")
					.set({ lease_token: "newer-owner", lease_expires_at: "2026-02-02T00:05:00.000Z" })
					.where("task_key", "=", "projection_gc")
					.execute();
				return original.call(this, input);
			},
		);

		expect((await cleanupMediaUsage(db)).status).toBe("skipped");
		const state = await db
			.selectFrom("_emdash_media_usage_cleanup")
			.select("lease_token")
			.where("task_key", "=", "projection_gc")
			.executeTakeFirstOrThrow();
		expect(state.lease_token).toBe("newer-owner");
	});
});

function contentSource(contentId: string) {
	return {
		sourceKey: `content:posts:${contentId}:columns`,
		sourceType: "content",
		collectionSlug: "posts",
		contentId,
		sourceVariant: "columns" as const,
		contentStatus: "published",
	};
}

function occurrence(mediaId: string, fieldPath = "hero") {
	return {
		fieldSlug: fieldPath,
		fieldPath,
		referenceType: "image_field" as const,
		mediaId,
		provider: "local",
		providerAssetId: mediaId,
	};
}

async function insertOccurrence(
	db: Kysely<Database>,
	input: {
		id: string;
		sourceKey: string;
		generation: string;
		mediaId: string;
		createdAt: string;
	},
): Promise<void> {
	await db
		.insertInto("_emdash_media_usage")
		.values({
			id: input.id,
			source_key: input.sourceKey,
			generation: input.generation,
			field_slug: "hero",
			field_path: input.id,
			occurrence_index: 0,
			reference_type: "image_field",
			media_id: input.mediaId,
			provider: "local",
			provider_asset_id: input.mediaId,
			media_kind: "image",
			mime_type: null,
			created_at: input.createdAt,
		})
		.execute();
}

async function makeCleanupEligible(db: Kysely<Database>): Promise<void> {
	await db
		.updateTable("_emdash_media_usage_cleanup")
		.set({ next_eligible_at: "1970-01-01T00:00:00.000Z" })
		.where("task_key", "=", "projection_gc")
		.execute();
}

async function databaseNowTimestamp(
	db: Kysely<Database>,
	dialect: DialectTestContext["dialect"],
): Promise<string> {
	if (dialect === "postgres") {
		const { rows } = await sql<{ value: string }>`
			SELECT to_char(
				clock_timestamp() AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			) AS value
		`.execute(db);
		return rows[0]!.value;
	}
	const { rows } = await sql<{ value: string }>`
		SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value
	`.execute(db);
	return rows[0]!.value;
}
