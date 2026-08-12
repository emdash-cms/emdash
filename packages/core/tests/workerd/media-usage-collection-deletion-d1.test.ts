import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { executeCollectionDeletionGuard } from "../../../cloudflare/src/db/d1.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../src/database/repositories/media-usage.js";
import type { Database } from "../../src/database/types.js";
import { processDueMediaUsageCollectionDeletions } from "../../src/media/usage/collection-deletion-processor.js";
import { buildContentMediaUsageSourceKey } from "../../src/media/usage/source-key.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

it("rejects interpolated collection identifiers before issuing D1 SQL", async () => {
	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "drop",
				collectionId: "collection-invalid",
				collectionSlug: 'posts";drop_table',
				leaseToken: "owner",
			},
		),
	).rejects.toThrow(/valid collection slug/i);
});

it("does not leave projection rows after collection identity disappears", async () => {
	const collectionId = "collection-d1-stale-projection";
	const collectionSlug = "d1_stale_projection";
	const contentId = "entry-1";
	const sourceKey = buildContentMediaUsageSourceKey({
		collectionId,
		collectionSlug,
		contentId,
		sourceVariant: "columns",
	});
	await db
		.insertInto("_emdash_collections")
		.values({ id: collectionId, slug: collectionSlug, label: "D1 stale projection" })
		.execute();
	await db.deleteFrom("_emdash_collections").where("id", "=", collectionId).execute();

	await expect(
		new MediaUsageRepository(db).replaceSource(
			{
				sourceKey,
				sourceType: "content",
				collectionId,
				collectionSlug,
				contentId,
				sourceVariant: "columns",
				identityVersion: 1,
			},
			[
				{
					fieldSlug: "hero",
					fieldPath: "hero",
					referenceType: "local",
					mediaId: "media-1",
					provider: "local",
					providerAssetId: "media-1",
				},
			],
		),
	).rejects.toThrow();

	expect(
		await db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("source_key", "=", sourceKey)
			.execute(),
	).toEqual([]);
	expect(
		await db
			.selectFrom("_emdash_media_usage")
			.select("source_key")
			.where("source_key", "=", sourceKey)
			.execute(),
	).toEqual([]);
});

it("rolls back a stale guarded batch before any collection DDL", async () => {
	await sql`CREATE TABLE ec_d1_guarded (id TEXT PRIMARY KEY)`.execute(db);
	await db
		.insertInto("_emdash_media_usage_collection_deletions")
		.values({
			collection_id: "collection-d1",
			collection_slug: "d1_guarded",
			force_delete: 1,
			state: "leased",
			phase: "table",
			next_attempt_at: "2000-01-01T00:00:00.000Z",
			lease_token: "current-owner",
			lease_expires_at: "2999-01-01T00:00:00.000Z",
		})
		.execute();

	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "drop",
				collectionId: "collection-d1",
				collectionSlug: "d1_guarded",
				leaseToken: "stale-owner",
			},
		),
	).resolves.toEqual({ outcome: "stale" });

	const table = await sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ec_d1_guarded'
	`.execute(db);
	expect(table.rows).toEqual([{ name: "ec_d1_guarded" }]);
	expect(
		await db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.execute(),
	).toEqual([{ collection_id: "collection-d1" }]);

	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "drop",
				collectionId: "collection-d1",
				collectionSlug: "d1_guarded",
				leaseToken: "current-owner",
			},
		),
	).resolves.toEqual({ outcome: "dropped" });
	const dropped = await sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ec_d1_guarded'
	`.execute(db);
	expect(dropped.rows).toEqual([]);
	expect(
		await db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.execute(),
	).toEqual([{ collection_id: "collection-d1" }]);
});

it("atomically preserves active content or fences a trashed collection", async () => {
	await sql`CREATE TABLE ec_d1_fence (id TEXT PRIMARY KEY, deleted_at TEXT)`.execute(db);
	await ctxInsertCollection();
	await db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: "content-media",
			scope_type: "collection",
			scope_key: "d1_fence",
			collection_id: "collection-d1-fence",
			status: "complete",
			capture_state: "active",
		})
		.execute();
	await db
		.insertInto("_emdash_media_usage_collection_deletions")
		.values({
			collection_id: "collection-d1-fence",
			collection_slug: "d1_fence",
			force_delete: 0,
			state: "leased",
			phase: "fence",
			next_attempt_at: "2000-01-01T00:00:00.000Z",
			lease_token: "fence-owner",
			lease_expires_at: "2999-01-01T00:00:00.000Z",
		})
		.execute();
	await sql`INSERT INTO ec_d1_fence (id) VALUES ('entry-1')`.execute(db);

	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "fence",
				collectionId: "collection-d1-fence",
				collectionSlug: "d1_fence",
				leaseToken: "fence-owner",
				forceDelete: false,
			},
		),
	).resolves.toEqual({ outcome: "has_content" });
	expect(await captureState()).toBe("active");
	await db.deleteFrom("_emdash_collections").where("id", "=", "collection-d1-fence").execute();
	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "fence",
				collectionId: "collection-d1-fence",
				collectionSlug: "d1_fence",
				leaseToken: "fence-owner",
				forceDelete: true,
			},
		),
	).resolves.toEqual({ outcome: "stale" });
	await ctxInsertCollection();

	await sql`UPDATE ec_d1_fence SET deleted_at = '2026-08-12T00:00:00.000Z'`.execute(db);
	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "fence",
				collectionId: "collection-d1-fence",
				collectionSlug: "d1_fence",
				leaseToken: "fence-owner",
				forceDelete: false,
			},
		),
	).resolves.toEqual({ outcome: "fenced" });
	expect(await captureState()).toBe("deleting");
});

it("drains at most fifty exact-ID work rows in a real D1 tick", async () => {
	await db
		.insertInto("_emdash_media_usage_collection_deletions")
		.values({
			collection_id: "collection-d1-cleanup",
			collection_slug: "d1_cleanup",
			force_delete: 1,
			state: "pending",
			phase: "work",
			next_attempt_at: "2000-01-01T00:00:00.000Z",
		})
		.execute();
	const work = Array.from({ length: 51 }, (_, index) => ({
		collection_id: "collection-d1-cleanup",
		collection_slug: "d1_cleanup",
		content_id: `d1-entry-${String(index).padStart(3, "0")}`,
		change_epoch: 1,
		next_attempt_at: "2000-01-01T00:00:00.000Z",
	}));
	for (let index = 0; index < work.length; index += 10) {
		await db
			.insertInto("_emdash_media_usage_work")
			.values(work.slice(index, index + 10))
			.execute();
	}

	await expect(processDueMediaUsageCollectionDeletions(db)).resolves.toMatchObject({
		claimedCount: 1,
		outcome: "progress",
	});
	const remaining = await db
		.selectFrom("_emdash_media_usage_work")
		.select("content_id")
		.where("collection_id", "=", "collection-d1-cleanup")
		.execute();
	expect(remaining).toEqual([{ content_id: "d1-entry-050" }]);
	await db
		.deleteFrom("_emdash_media_usage_work")
		.where("collection_id", "=", "collection-d1-cleanup")
		.execute();
	await db
		.deleteFrom("_emdash_media_usage_collection_deletions")
		.where("collection_id", "=", "collection-d1-cleanup")
		.execute();
});

it("records bounded real-D1 cost evidence through finalization", async () => {
	await db
		.insertInto("_emdash_media_usage_collection_deletions")
		.values({
			collection_id: "collection-d1-measure",
			collection_slug: "d1_measure",
			force_delete: 1,
			state: "pending",
			phase: "work",
			next_attempt_at: "2000-01-01T00:00:00.000Z",
		})
		.execute();
	const measuredWork = Array.from({ length: 51 }, (_, index) => ({
		collection_id: "collection-d1-measure",
		collection_slug: "d1_measure",
		content_id: `measured-entry-${String(index).padStart(3, "0")}`,
		change_epoch: 1,
		next_attempt_at: "2000-01-01T00:00:00.000Z",
	}));
	for (let index = 0; index < measuredWork.length; index += 10) {
		await db
			.insertInto("_emdash_media_usage_work")
			.values(measuredWork.slice(index, index + 10))
			.execute();
	}
	await db
		.insertInto("_emdash_media_usage_sources")
		.values({
			source_key: "d1-measured-source",
			source_type: "content",
			collection_id: "collection-d1-measure",
			collection_slug: "d1_measure",
			content_id: "entry",
			source_variant: "columns",
			current_generation: "generation",
		})
		.execute();
	const measuredOccurrences = Array.from({ length: 51 }, (_, index) => ({
		id: `d1-measured-usage-${String(index).padStart(3, "0")}`,
		source_key: "d1-measured-source",
		generation: "generation",
		field_slug: "hero",
		field_path: `hero[${index}]`,
		occurrence_index: index,
		reference_type: "local",
		media_id: `media-${index}`,
		provider_asset_id: `media-${index}`,
	}));
	for (let index = 0; index < measuredOccurrences.length; index += 5) {
		await db
			.insertInto("_emdash_media_usage")
			.values(measuredOccurrences.slice(index, index + 5))
			.execute();
	}
	await db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: "content-media",
			scope_type: "collection",
			scope_key: "d1_measure",
			collection_id: "collection-d1-measure",
			status: "stale",
			capture_state: "deleting",
		})
		.execute();

	const evidence: Array<Record<string, number | string>> = [];
	for (let tick = 0; tick < 8; tick++) {
		const deletion = await db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("phase")
			.where("collection_id", "=", "collection-d1-measure")
			.executeTakeFirst();
		if (!deletion) break;
		const measurement = emptyMeasurement();
		const measuredDb = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, measurement) }),
		});
		const startedAt = performance.now();
		await processDueMediaUsageCollectionDeletions(measuredDb);
		await measuredDb.destroy();
		const wallDurationMs = performance.now() - startedAt;
		expect(measurement.queries).toBeLessThanOrEqual(40);
		expect(measurement.maxBinds).toBeLessThanOrEqual(100);
		expect(measurement.maxSqlBytes).toBeLessThan(100 * 1024);
		expect(measurement.rowsWritten).toBeLessThanOrEqual(70);
		expect(wallDurationMs).toBeLessThan(2500);
		evidence.push({ phase: deletion.phase, ...measurement, wallDurationMs });
	}
	expect(
		await db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.where("collection_id", "=", "collection-d1-measure")
			.executeTakeFirst(),
	).toBeUndefined();
	console.info(`PR2_D1_COLLECTION_DELETION=${JSON.stringify(evidence)}`);
});

async function ctxInsertCollection(): Promise<void> {
	await db
		.insertInto("_emdash_collections")
		.values({ id: "collection-d1-fence", slug: "d1_fence", label: "D1 fence" })
		.execute();
}

async function captureState(): Promise<string | null> {
	const row = await db
		.selectFrom("_emdash_media_usage_index_status")
		.select("capture_state")
		.where("collection_id", "=", "collection-d1-fence")
		.executeTakeFirst();
	return row?.capture_state ?? null;
}

interface D1Measurement {
	queries: number;
	rowsRead: number;
	rowsWritten: number;
	durationMs: number;
	maxBinds: number;
	maxSqlBytes: number;
}

function emptyMeasurement(): D1Measurement {
	return { queries: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0, maxBinds: 0, maxSqlBytes: 0 };
}

function captureD1(database: D1Database, measurement: D1Measurement): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => captureStatement(target.prepare(query), query, [], measurement);
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function captureStatement(
	statement: D1PreparedStatement,
	query: string,
	binds: unknown[],
	measurement: D1Measurement,
): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property) {
			if (property === "bind") {
				return (...values: unknown[]) =>
					captureStatement(target.bind(...values), query, values, measurement);
			}
			if (property === "all") {
				return async <T>() => {
					const result = await target.all<T>();
					measurement.queries++;
					measurement.rowsRead += result.meta.rows_read;
					measurement.rowsWritten += result.meta.rows_written;
					measurement.durationMs += result.meta.duration;
					measurement.maxBinds = Math.max(measurement.maxBinds, binds.length);
					measurement.maxSqlBytes = Math.max(
						measurement.maxSqlBytes,
						new TextEncoder().encode(query).byteLength,
					);
					return result;
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
