import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleImportAdvance } from "../../../../src/api/handlers/transfer.js";
import type { Database } from "../../../../src/database/types.js";
import { activateMediaUsageCapture } from "../../../../src/media/usage/activation.js";
import { findSiteWriteFenceError } from "../../../../src/transfer/fence.js";
import { canonicalJson } from "../../../../src/transfer/format/canonical.js";
import {
	advanceImport,
	IMPORT_RETRY_MS,
	IMPORT_UNIT_ENTITY,
	importRetryDelay,
} from "../../../../src/transfer/import/index.js";
import { TransferOperationRepository } from "../../../../src/transfer/ops/operations.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { GOLDEN_IDS } from "../../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { dumpTarget, expectTargetMatchesGolden, mediaKeys } from "./expectations.js";
import {
	countingBudget,
	driveImport,
	seedTarget,
	stageGoldenImport,
	TARGET_USER,
	verifyOk,
	withFaults,
} from "./harness.js";

const ids = GOLDEN_IDS;

async function expireLeases(db: Kysely<Database>): Promise<void> {
	await db
		.updateTable("_emdash_transfer_operations")
		.set({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
		.where("lease_token", "is not", null)
		.execute();
}

/** A dump with each run's media storage keys replaced by the media id they belong to. */
async function normalizedDump(db: Kysely<Database>): Promise<Record<string, string[]>> {
	const keys = await mediaKeys(db);
	const dump = await dumpTarget(db);
	const normalized: Record<string, string[]> = {};
	for (const [table, rows] of Object.entries(dump)) {
		normalized[table] = rows
			.map((row) => {
				let text = row;
				for (const [mediaId, key] of keys) text = text.replaceAll(key, `<key:${mediaId}>`);
				return text;
			})
			.toSorted();
	}
	return normalized;
}

describeEachDialect("site import resumption", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
		await seedTarget(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it(
		"survives a crash after every statement and converges on the uninterrupted result",
		{ timeout: 600_000 },
		async () => {
			const reference = await setupForDialect(dialect);
			try {
				const referenceStorage = createMemoryStorage();
				await seedTarget(reference.db);
				const clean = await stageGoldenImport(reference.db, referenceStorage, dialect);
				await driveImport(reference.db, referenceStorage, clean.operationId);
				const expected = await normalizedDump(reference.db);

				const staged = await stageGoldenImport(ctx.db, storage, dialect);
				const { db, faults } = withFaults(ctx.db);
				const ops = new TransferOperationRepository(ctx.db);
				let offset = 1;
				let lastCursor = "";
				let crashes = 0;
				for (;;) {
					faults.failAfter(offset);
					try {
						const result = await advanceImport({
							db,
							storage,
							operationId: staged.operationId,
							verify: verifyOk,
						});
						const crashed = faults.crashed;
						faults.disarm();
						if (!crashed && result.nextRequestInMs === null) break;
						if (!crashed) continue;
					} catch (error) {
						expect(faults.crashed).toBe(true);
						faults.disarm();
						expect((error as Error).message).toContain("injected crash");
					}
					crashes++;
					await expireLeases(ctx.db);
					const operation = await ops.require(staged.operationId);
					const cursor = canonicalJson(operation.cursor ?? null);
					if (cursor === lastCursor) offset++;
					else {
						lastCursor = cursor;
						offset = 1;
					}
				}

				const operation = await ops.require(staged.operationId);
				expect(operation.state).toBe("complete");
				expect(crashes).toBeGreaterThan(100);
				await expectTargetMatchesGolden(ctx.db, staged.golden, staged.plan);
				expect(await normalizedDump(ctx.db)).toEqual(expected);
			} finally {
				await teardownForDialect(reference);
			}
		},
	);

	it("retries a media copy that failed in storage", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		let failures = 0;
		storage.beforeUpload = (key) => {
			if (!key.startsWith("transfers/") && failures === 0) {
				failures++;
				throw new Error("storage unavailable");
			}
		};
		const failed = await advanceImport({
			db: ctx.db,
			storage,
			operationId: staged.operationId,
			verify: verifyOk,
		});
		expect(failed.operation.state).toBe("running");
		expect(failed.operation.errorCode).toBe("TRANSFER_STORAGE_ERROR");
		expect(failed.operation.errorDetail).toMatchObject({ attempts: 1 });
		expect(failed.nextRequestInMs).toBe(IMPORT_RETRY_MS);
		storage.beforeUpload = undefined;
		const results = await driveImport(ctx.db, storage, staged.operationId);
		expect(results[0]?.operation.errorCode).toBeNull();
		expect(results.at(-1)!.operation.state).toBe("complete");
		await expectTargetMatchesGolden(ctx.db, staged.golden, staged.plan);
		const targetObjects = [...storage.files.keys()].filter((key) => !key.startsWith("transfers/"));
		expect(targetObjects).toHaveLength(4);
	});

	it("fails after a few attempts when a staged file is gone, backing off between them", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const chunk = [...storage.files.keys()].find((key) =>
			key.endsWith("records/comment/000000.ndjson"),
		);
		storage.files.delete(chunk!);
		const results = await driveImport(ctx.db, storage, staged.operationId);
		const retries = results.filter((result) => result.operation.errorCode !== null);
		expect(retries.map((result) => result.nextRequestInMs)).toEqual([
			importRetryDelay(1),
			importRetryDelay(2),
			null,
		]);
		expect(importRetryDelay(2)).toBe(2 * IMPORT_RETRY_MS);
		const operation = results.at(-1)!.operation;
		expect(operation.state).toBe("failed");
		expect(operation.errorCode).toBe("TRANSFER_FILE_MISSING");
		expect(operation.errorDetail).toMatchObject({ attempts: 3 });
	});

	it("resets the retry count once a step makes progress", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		let failures = 0;
		storage.beforeUpload = (key) => {
			if (!key.startsWith("transfers/") && failures < 2) {
				failures++;
				throw new Error("storage unavailable");
			}
		};
		const results = await driveImport(db, storage, staged.operationId, {
			budget: countingBudget(faults, 100),
		});
		storage.beforeUpload = undefined;
		expect(failures).toBe(2);
		expect(results.at(-1)!.operation.state).toBe("complete");
		const attempts = results.map((result) => result.operation.errorDetail?.attempts ?? 0);
		expect(Math.max(...attempts)).toBeLessThanOrEqual(2);
	});

	it("runs in bounded steps with every statement inside D1's bind limit", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		const ceiling = 100;
		const perStep: number[] = [];
		let steps = 0;
		for (;;) {
			const before = faults.executed;
			const result = await advanceImport({
				db,
				storage,
				operationId: staged.operationId,
				verify: verifyOk,
				budget: countingBudget(faults, ceiling)(),
			});
			perStep.push(faults.executed - before);
			steps++;
			if (result.nextRequestInMs === null) break;
			expect(steps).toBeLessThan(500);
		}
		expect(steps).toBeGreaterThan(3);
		expect(Math.max(...perStep)).toBeLessThanOrEqual(ceiling);
		expect(faults.maxParameters).toBeLessThanOrEqual(100);
		await expectTargetMatchesGolden(ctx.db, staged.golden, staged.plan);
	});

	it("stops at the next checkpoint when cancellation is requested mid-step", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		const ops = new TransferOperationRepository(ctx.db);
		let checkpoints = 0;
		faults.afterCheckpoint = async () => {
			checkpoints++;
			if (checkpoints === 12) await ops.requestCancel(staged.operationId);
		};
		const result = await advanceImport({
			db,
			storage,
			operationId: staged.operationId,
			verify: verifyOk,
		});
		faults.afterCheckpoint = null;

		expect(result.nextRequestInMs).toBeNull();
		expect(result.operation.state).toBe("cancelled");
		expect(result.operation.mutationStartedAt).not.toBeNull();
		expect(result.operation.receipt).toBeNull();
		expect(await findSiteWriteFenceError(ctx.db)).toMatchObject({
			code: "TRANSFER_IMPORT_IN_PROGRESS",
		});
		const entries = await ctx.db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("id", "in", [ids.posts, ids.pages])
			.execute();
		const comments = await ctx.db.selectFrom("_emdash_comments").select("id").execute();
		expect(entries.length).toBeGreaterThan(0);
		expect(comments).toEqual([]);

		const again = await advanceImport({
			db: ctx.db,
			storage,
			operationId: staged.operationId,
			verify: verifyOk,
		});
		expect(again.operation.state).toBe("cancelled");
		expect(await ctx.db.selectFrom("_emdash_comments").select("id").execute()).toEqual([]);
	});

	it("asks the caller to retry when another caller takes the lease mid-step", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		let checkpoints = 0;
		faults.afterCheckpoint = async () => {
			checkpoints++;
			if (checkpoints !== 3) return;
			await ctx.db
				.updateTable("_emdash_transfer_operations")
				.set({ lease_token: "another-caller", lease_expires_at: "2999-01-01T00:00:00.000Z" })
				.where("id", "=", staged.operationId)
				.execute();
		};
		const step = await handleImportAdvance(db, storage, {
			operationId: staged.operationId,
			userId: TARGET_USER,
		});
		faults.afterCheckpoint = null;

		expect(step.success ? null : step.error).toBeNull();
		if (!step.success) return;
		expect(step.data.nextRequestInMs).toBeGreaterThan(0);
		expect(step.data.operation.state).toBe("running");
		expect(step.data.operation.errorCode).toBeNull();

		await expireLeases(ctx.db);
		const results = await driveImport(ctx.db, storage, staged.operationId);
		expect(results.at(-1)!.operation.state).toBe("complete");
	});

	it("cancels at once between steps", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		await advanceImport({
			db,
			storage,
			operationId: staged.operationId,
			verify: verifyOk,
			budget: countingBudget(faults, 150)(),
		});
		const cancelled = await new TransferOperationRepository(ctx.db).requestCancel(
			staged.operationId,
		);
		expect(cancelled.state).toBe("cancelled");
		const again = await advanceImport({
			db: ctx.db,
			storage,
			operationId: staged.operationId,
			verify: verifyOk,
		});
		expect(again.nextRequestInMs).toBeNull();
		expect(again.operation.state).toBe("cancelled");
	});

	it("fails instead of rewriting when a resumed unit reads back a different row", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		let inserted = false;
		faults.afterCheckpoint = async () => {
			if (inserted) return;
			const operation = await new TransferOperationRepository(ctx.db).require(staged.operationId);
			if (operation.stage !== "presentation") return;
			inserted = true;
			await ctx.db
				.insertInto("_emdash_transfer_identity_map")
				.values({
					origin_site_id: ids.originSiteId,
					operation_id: staged.operationId,
					entity_kind: IMPORT_UNIT_ENTITY,
					portable_id: "presentation:widget_area:0:0",
					target_id: "started",
				})
				.execute();
			await ctx.db
				.insertInto("_emdash_widget_areas")
				.values({ id: ids.sidebar, name: "sidebar", label: "Changed", description: null })
				.execute();
		};
		const results = await driveImport(db, storage, staged.operationId);
		faults.afterCheckpoint = null;

		const operation = results.at(-1)!.operation;
		expect(operation.state).toBe("failed");
		expect(operation.errorCode).toBe("TRANSFER_IMPORT_ERROR");
		expect(operation.errorDetail).toMatchObject({
			kind: "widget_area",
			id: ids.sidebar,
			reason: "stored_row_mismatch",
		});
		const mapped = await ctx.db
			.selectFrom("_emdash_transfer_identity_map")
			.select("portable_id")
			.where("entity_kind", "=", "widget_area")
			.execute();
		expect(mapped).toEqual([]);
	});

	it("writes a colliding record under a rewritten id and points references at it", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		let inserted = false;
		faults.afterCheckpoint = async () => {
			if (inserted) return;
			const operation = await new TransferOperationRepository(ctx.db).require(staged.operationId);
			if (operation.stage !== "presentation") return;
			inserted = true;
			await ctx.db
				.insertInto("_emdash_widget_areas")
				.values({ id: ids.sidebar, name: "footer", label: "Footer", description: null })
				.execute();
		};
		const results = await driveImport(db, storage, staged.operationId);
		faults.afterCheckpoint = null;
		expect(inserted).toBe(true);
		expect(results.at(-1)!.operation.state).toBe("complete");

		const mapped = await ctx.db
			.selectFrom("_emdash_transfer_identity_map")
			.select(["entity_kind", "portable_id", "target_id"])
			.where("entity_kind", "=", "widget_area")
			.execute();
		expect(mapped).toHaveLength(1);
		const [mapping] = mapped;
		expect(mapping?.portable_id).toBe(ids.sidebar);
		expect(mapping?.target_id).not.toBe(ids.sidebar);

		const areas = await ctx.db
			.selectFrom("_emdash_widget_areas")
			.select(["id", "name"])
			.orderBy("name")
			.execute();
		expect(areas).toEqual([
			{ id: ids.sidebar, name: "footer" },
			{ id: mapping?.target_id, name: "sidebar" },
		]);
		const widgets = await ctx.db.selectFrom("_emdash_widgets").select(["id", "area_id"]).execute();
		expect(widgets.map((widget) => widget.area_id)).toEqual([
			mapping?.target_id,
			mapping?.target_id,
		]);
	});

	it("fails a batch that breaks a target unique constraint and leaves none of it behind", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		let inserted = false;
		faults.afterCheckpoint = async () => {
			if (inserted) return;
			const operation = await new TransferOperationRepository(ctx.db).require(staged.operationId);
			if (operation.stage !== "presentation") return;
			inserted = true;
			await ctx.db
				.insertInto("_emdash_menus")
				.values({ id: "unrelated_menu", name: "primary", label: "Other", locale: "fr" })
				.execute();
		};
		const results = await driveImport(db, storage, staged.operationId);
		faults.afterCheckpoint = null;

		const operation = results.at(-1)!.operation;
		expect(operation.state).toBe("failed");
		expect(operation.errorCode).toBe("TRANSFER_IMPORT_ERROR");
		expect(operation.errorDetail).toMatchObject({ kind: "menu", id: ids.primaryFr });
		const menus = await ctx.db.selectFrom("_emdash_menus").select("id").execute();
		expect(menus.map((menu) => menu.id)).toEqual(["unrelated_menu"]);
		expect(await findSiteWriteFenceError(ctx.db)).toMatchObject({
			code: "TRANSFER_IMPORT_IN_PROGRESS",
		});
	});

	it("refuses to start when a mapped target user no longer exists", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		await ctx.db.deleteFrom("users").where("id", "=", TARGET_USER).execute();
		const results = await driveImport(ctx.db, storage, staged.operationId);
		const operation = results.at(-1)!.operation;
		expect(operation.state).toBe("failed");
		expect(operation.errorCode).toBe("TRANSFER_DECISIONS_INVALID");
		expect(operation.errorDetail).toEqual({ principal: ids.bob });
		const collections = await ctx.db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("id", "in", [ids.posts, ids.pages])
			.execute();
		expect(collections).toEqual([]);
	});

	it("fails without fencing the site when content appeared after analysis", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		await sql`
			INSERT INTO ec_posts (id, slug, status, locale) VALUES ('late', 'late', 'draft', 'en')
		`.execute(ctx.db);
		const results = await driveImport(ctx.db, storage, staged.operationId);
		const operation = results.at(-1)!.operation;
		expect(operation.state).toBe("failed");
		expect(operation.errorCode).toBe("TRANSFER_TARGET_NOT_EMPTY");
		expect(operation.mutationStartedAt).toBeNull();
		expect(await findSiteWriteFenceError(ctx.db)).toBeNull();
	});

	it(
		"imports with media-usage capture active and deletes the seeded collections first",
		{ timeout: 60_000 },
		async () => {
			const fresh = await setupForDialect(dialect);
			try {
				const freshStorage = createMemoryStorage();
				expect(await activateMediaUsageCapture(fresh.db, { writersDrained: true })).toMatchObject({
					outcome: "active",
				});
				await seedTarget(fresh.db);
				const staged = await stageGoldenImport(fresh.db, freshStorage, dialect);
				const results = await driveImport(fresh.db, freshStorage, staged.operationId);
				expect(results.at(-1)!.operation.state).toBe("complete");
				await expectTargetMatchesGolden(fresh.db, staged.golden, staged.plan);

				const statuses = await fresh.db
					.selectFrom("_emdash_media_usage_index_status")
					.select(["scope_key", "collection_id", "capture_state", "status"])
					.where("adapter_id", "=", "content-media")
					.where("scope_type", "=", "collection")
					.orderBy("scope_key")
					.execute();
				expect(statuses).toEqual([
					{
						scope_key: "pages",
						collection_id: ids.pages,
						capture_state: "active",
						status: "stale",
					},
					{
						scope_key: "posts",
						collection_id: ids.posts,
						capture_state: "active",
						status: "stale",
					},
				]);
				const deletions = await fresh.db
					.selectFrom("_emdash_media_usage_collection_deletions")
					.selectAll()
					.execute();
				expect(deletions).toEqual([]);
			} finally {
				await teardownForDialect(fresh);
			}
		},
	);
});
