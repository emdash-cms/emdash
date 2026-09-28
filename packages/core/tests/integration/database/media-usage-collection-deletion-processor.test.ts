import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { activateMediaUsageCapture } from "../../../src/media/usage/activation.js";
import { processDueMediaUsageCollectionDeletions } from "../../../src/media/usage/collection-deletion-processor.js";
import { MediaUsageCollectionDeletionRepository } from "../../../src/media/usage/collection-deletion.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	setupTestDatabaseWithCompoundSelectLimit,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage collection deletion processor", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("resumes bounded exact-ID cleanup and removes the tombstone last", async () => {
		await insertDeletion("old-id", "articles", "work");
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "articles",
				collection_id: "old-id",
				status: "stale",
				capture_state: "deleting",
			})
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage_work")
			.values(
				Array.from({ length: 55 }, (_, index) => ({
					collection_id: "old-id",
					collection_slug: "articles",
					content_id: `entry-${String(index).padStart(3, "0")}`,
					change_epoch: 1,
					next_attempt_at: "2000-01-01T00:00:00.000Z",
				})),
			)
			.execute();
		await insertSource("old-source", "old-id", "articles");
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values(
				Array.from({ length: 55 }, (_, index) => ({
					id: `usage-${String(index).padStart(3, "0")}`,
					source_key: "old-source",
					generation: "generation-old",
					field_slug: "hero",
					field_path: `hero[${index}]`,
					occurrence_index: index,
					reference_type: "local",
					media_id: `media-${index}`,
					provider_asset_id: `media-${index}`,
				})),
			)
			.execute();
		await insertSource("legacy-source", null, "articles");
		await insertSource("replacement-source", "replacement-id", "articles");

		await expect(runTick()).resolves.toMatchObject({ claimedCount: 1, outcome: "progress" });
		expect(await workCount("old-id")).toBe(5);
		expect(await deletionState("old-id")).toEqual(
			expect.objectContaining({ phase: "work", work_cursor: "entry-049" }),
		);

		await runTick();
		expect(await workCount("old-id")).toBe(0);
		expect(await deletionState("old-id")).toEqual(expect.objectContaining({ phase: "sources" }));

		await runTick();
		expect(await usageCount("old-source")).toBe(5);
		expect(await deletionState("old-id")).toEqual(
			expect.objectContaining({
				phase: "sources",
				source_key: "old-source",
				occurrence_cursor: "usage-049",
			}),
		);
		await ctx.db
			.deleteFrom("_emdash_media_usage_sources")
			.where("source_key", "=", "old-source")
			.execute();

		await runTick();
		expect(await usageCount("old-source")).toBe(0);
		expect(await sourceExists("old-source")).toBe(false);
		await runTick();
		expect(await deletionState("old-id")).toEqual(expect.objectContaining({ phase: "status" }));
		await runTick();
		expect(await deletionState("old-id")).toEqual(expect.objectContaining({ phase: "finalize" }));
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select("collection_id")
				.where("collection_id", "=", "old-id")
				.executeTakeFirst(),
		).toBeUndefined();
		await runTick();
		expect(await deletionState("old-id")).toBeNull();
		expect(await sourceExists("legacy-source")).toBe(true);
		expect(await sourceExists("replacement-source")).toBe(true);
	});

	it("recovers exactly one interrupted front phase per tick", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		const registry = new SchemaRegistry(ctx.db);
		const collection = await registry.createCollection({ slug: "front", label: "Front" });
		await new MediaUsageCollectionDeletionRepository(ctx.db).createTombstone({
			collectionId: collection.id,
			collectionSlug: collection.slug,
			forceDelete: true,
		});

		await runTick();
		expect(await deletionState(collection.id)).toEqual(
			expect.objectContaining({ state: "pending", phase: "registry" }),
		);
		expect(await registry.getCollection("front")).not.toBeNull();

		await runTick();
		expect(await deletionState(collection.id)).toEqual(
			expect.objectContaining({ state: "pending", phase: "table" }),
		);
		expect(await registry.getCollection("front")).toBeNull();

		await runTick();
		expect(await deletionState(collection.id)).toEqual(
			expect.objectContaining({ state: "pending", phase: "work" }),
		);
	});

	it("makes five consecutive phase failures visible", async () => {
		await insertDeletion("failed-id", "failed", "status");
		await ctx.db
			.insertInto("_emdash_media_usage_work")
			.values({
				collection_id: "failed-id",
				collection_slug: "failed",
				content_id: "still-present",
				change_epoch: 1,
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		for (let attempt = 1; attempt <= 5; attempt++) {
			const result = await runTick();
			expect(result.outcome).toBe(attempt === 5 ? "failed" : "retry");
			if (attempt < 5) {
				await ctx.db
					.updateTable("_emdash_media_usage_collection_deletions")
					.set({ next_attempt_at: "2000-01-01T00:00:00.000Z" })
					.where("collection_id", "=", "failed-id")
					.execute();
			}
		}

		expect(await deletionState("failed-id")).toEqual(
			expect.objectContaining({
				state: "failed",
				phase: "status",
				attempt_count: 5,
				last_error_code: "MEDIA_USAGE_COLLECTION_DELETION_FAILED",
			}),
		);
		error.mockRestore();
	});

	it("inspects at most four candidates and claims at most one deletion", async () => {
		for (let index = 0; index < 5; index++) {
			await insertDeletion(`collection-${index}`, `collection_${index}`, "work");
		}

		const result = await runTick();

		expect(result.candidateCount).toBe(4);
		expect(result.claimedCount).toBe(1);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.select("phase")
				.where("phase", "=", "sources")
				.execute(),
		).toHaveLength(1);
	});

	it.runIf(dialect === "sqlite")("tries the next due candidate after a claim race", async () => {
		await insertDeletion("first-id", "first", "work");
		await insertDeletion("second-id", "second", "work");
		await sql
			.raw(`
					CREATE TRIGGER lose_first_collection_deletion_claim
					BEFORE UPDATE OF state ON _emdash_media_usage_collection_deletions
					WHEN OLD.collection_id = 'first-id' AND NEW.state = 'leased'
					BEGIN
						SELECT RAISE(IGNORE);
					END
				`)
			.execute(ctx.db);

		const result = await runTick();

		expect(result).toMatchObject({ candidateCount: 2, claimedCount: 1, outcome: "progress" });
		expect(await deletionState("first-id")).toEqual(expect.objectContaining({ phase: "work" }));
		expect(await deletionState("second-id")).toEqual(expect.objectContaining({ phase: "sources" }));
	});

	it.runIf(dialect === "sqlite")("uses every declared deletion selector index", async () => {
		const plans = await Promise.all([
			sql
				.raw(
					"EXPLAIN QUERY PLAN SELECT collection_id FROM _emdash_media_usage_collection_deletions WHERE state = 'pending' AND next_attempt_at <= '2026-01-01T00:00:00.000Z' ORDER BY next_attempt_at, updated_at, collection_id LIMIT 4",
				)
				.execute(ctx.db),
			sql
				.raw(
					"EXPLAIN QUERY PLAN SELECT collection_id FROM _emdash_media_usage_collection_deletions WHERE state = 'leased' AND lease_expires_at <= '2026-01-01T00:00:00.000Z' ORDER BY lease_expires_at, updated_at, collection_id LIMIT 4",
				)
				.execute(ctx.db),
			sql
				.raw(
					"EXPLAIN QUERY PLAN SELECT collection_id FROM _emdash_media_usage_collection_deletions WHERE state = 'failed' ORDER BY updated_at DESC, collection_id DESC LIMIT 50",
				)
				.execute(ctx.db),
			sql
				.raw(
					"EXPLAIN QUERY PLAN SELECT source_key FROM _emdash_media_usage_sources WHERE source_type = 'content' AND collection_id = 'old-id' ORDER BY source_key LIMIT 1",
				)
				.execute(ctx.db),
			sql
				.raw(
					"EXPLAIN QUERY PLAN SELECT id FROM _emdash_media_usage WHERE source_key = 'source' AND id > 'cursor' ORDER BY id LIMIT 51",
				)
				.execute(ctx.db),
		]);
		const indexes = [
			"idx__emdash_media_usage_collection_deletions_due",
			"idx__emdash_media_usage_collection_deletions_lease",
			"idx__emdash_media_usage_collection_deletions_operator",
			"idx__emdash_media_usage_sources_collection_cursor",
			"idx__emdash_media_usage_source_cursor",
		];
		for (const [index, plan] of plans.entries()) {
			expect(plan.rows.map((row) => JSON.stringify(row)).join(" ")).toContain(indexes[index]);
		}
	});

	it.runIf(dialect === "sqlite")(
		"uses database time when a progress handoff is interrupted",
		async () => {
			await insertDeletion("clock-id", "clock", "work");
			await sql
				.raw(`
				CREATE TRIGGER interrupt_collection_deletion_release
				BEFORE UPDATE OF state ON _emdash_media_usage_collection_deletions
				WHEN OLD.collection_id = 'clock-id' AND NEW.state = 'pending'
				BEGIN
					SELECT RAISE(IGNORE);
				END
			`)
				.execute(ctx.db);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
			try {
				await runTick();
			} finally {
				vi.useRealTimers();
			}

			expect((await deletionState("clock-id"))?.updated_at.startsWith("2099-")).toBe(false);
		},
	);

	function runTick() {
		return processDueMediaUsageCollectionDeletions(ctx.db);
	}

	async function insertDeletion(collectionId: string, slug: string, phase: string) {
		await ctx.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: collectionId,
				collection_slug: slug,
				force_delete: 1,
				state: "pending",
				phase,
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
	}

	async function insertSource(sourceKey: string, collectionId: string | null, slug: string) {
		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: sourceKey,
				source_type: "content",
				collection_id: collectionId,
				collection_slug: slug,
				content_id: "entry",
				source_variant: "columns",
				current_generation: "generation-old",
			})
			.execute();
	}

	async function workCount(collectionId: string) {
		const row = await ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("collection_id", "=", collectionId)
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	async function usageCount(sourceKey: string) {
		const row = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("source_key", "=", sourceKey)
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	async function sourceExists(sourceKey: string) {
		return (
			(await ctx.db
				.selectFrom("_emdash_media_usage_sources")
				.select("source_key")
				.where("source_key", "=", sourceKey)
				.executeTakeFirst()) !== undefined
		);
	}

	async function deletionState(collectionId: string) {
		return (
			(await ctx.db
				.selectFrom("_emdash_media_usage_collection_deletions")
				.selectAll()
				.where("collection_id", "=", collectionId)
				.executeTakeFirst()) ?? null
		);
	}
});

it("selects one globally bounded due-candidate window", async () => {
	const fixture = await setupTestDatabaseWithCompoundSelectLimit(null);
	try {
		for (const [state, timestamp] of [
			["pending", "next_attempt_at"],
			["retry", "next_attempt_at"],
			["leased", "lease_expires_at"],
		] as const) {
			for (let index = 0; index < 4; index++) {
				await fixture.db
					.insertInto("_emdash_media_usage_collection_deletions")
					.values({
						collection_id: `${state}-${index}`,
						collection_slug: `${state}_${index}`,
						force_delete: 1,
						state,
						phase: "work",
						next_attempt_at: "2000-01-01T00:00:00.000Z",
						lease_token: state === "leased" ? `lease-${index}` : null,
						lease_expires_at: timestamp === "lease_expires_at" ? "2000-01-01T00:00:00.000Z" : null,
					})
					.execute();
			}
		}
		fixture.statements.length = 0;

		const due = await new MediaUsageCollectionDeletionRepository(fixture.db).findDue(4);

		expect(due).toHaveLength(4);
		expect(
			fixture.statements.filter(
				(statement) =>
					/^(?:select|with)/i.test(statement.trim()) &&
					statement.includes("_emdash_media_usage_collection_deletions"),
			),
		).toHaveLength(1);
	} finally {
		await fixture.db.destroy();
	}
});

it("checks cleanup completion in one bounded query", async () => {
	const fixture = await setupTestDatabaseWithCompoundSelectLimit(null);
	try {
		await fixture.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: "status-id",
				collection_slug: "status_slug",
				force_delete: 1,
				state: "pending",
				phase: "status",
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
		await fixture.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "status_slug",
				collection_id: "status-id",
				status: "stale",
				capture_state: "deleting",
			})
			.execute();
		fixture.statements.length = 0;

		await processDueMediaUsageCollectionDeletions(fixture.db);

		const probes = fixture.statements.filter(
			(statement) =>
				/^select/i.test(statement.trim()) &&
				(statement.includes("_emdash_media_usage_work") ||
					statement.includes("_emdash_media_usage_sources") ||
					statement.includes("_emdash_media_usage_index_status")),
		);
		expect(probes).toHaveLength(1);
	} finally {
		await fixture.db.destroy();
	}
});
