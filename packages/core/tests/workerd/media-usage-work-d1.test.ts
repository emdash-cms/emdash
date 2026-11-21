import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import {
	MediaUsageWorkRepository,
	type MediaUsageWorkLease,
} from "../../src/database/repositories/media-usage-work.js";
import type { Database } from "../../src/database/types.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

interface Measurement {
	rowsRead: number;
}

interface SeededWork {
	collectionId: string;
	validLeases: MediaUsageWorkLease[];
	invalidLeases: MediaUsageWorkLease[];
}

let adminDb: Kysely<Database>;

beforeAll(async () => {
	adminDb = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: env.DB }),
	});
	await runMigrations(adminDb);
});

afterEach(async () => {
	await sql`DELETE FROM _emdash_media_usage_work`.execute(adminDb);
});

afterAll(async () => {
	await adminDb.destroy();
});

it.each(["complete", "retry", "release"] as const)(
	"transitions only selected leases with bounded reads (%s)",
	async (operation) => {
		const seeded = await seedWork(operation);
		const measurement: Measurement = { rowsRead: 0 };
		const db = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, measurement) }),
		});
		const repository = new MediaUsageWorkRepository(db);

		let transitioned: Set<string> | Map<string, "retry" | "failed">;
		if (operation === "complete") {
			transitioned = await repository.completeWorkBatch([
				...seeded.validLeases,
				...seeded.invalidLeases,
			]);
		} else if (operation === "retry") {
			transitioned = await repository.retryClaimedWorkBatch({
				work: [...seeded.validLeases, ...seeded.invalidLeases],
				errorCode: "TEST_ERROR",
				retryDelaySeconds: 60,
				maxAttempts: 3,
			});
		} else {
			transitioned = await repository.releaseClaimedWorkBatch([
				...seeded.validLeases,
				...seeded.invalidLeases,
			]);
		}
		await db.destroy();

		expect(transitioned.size).toBe(50);
		expect(measurement.rowsRead).toBeLessThan(10_000);

		const rows = await adminDb
			.selectFrom("_emdash_media_usage_work")
			.select(["content_id", "state", "lease_token", "work_version"])
			.where("collection_id", "=", seeded.collectionId)
			.execute();
		const byContentId = new Map(rows.map((row) => [row.content_id, row]));

		const expectedState = operation === "retry" ? "retry" : "pending";
		expect(rows).toHaveLength(operation === "complete" ? 2_950 : 3_000);
		expect(rows.filter((row) => row.state === expectedState)).toHaveLength(
			operation === "complete" ? 0 : 50,
		);
		for (const lease of seeded.validLeases) {
			if (operation === "complete") {
				expect(byContentId.get(lease.contentId)).toBeUndefined();
			} else {
				expect(byContentId.get(lease.contentId)).toMatchObject({
					state: expectedState,
					lease_token: null,
				});
			}
		}
		for (let index = 50; index < 2_997; index++) {
			expect(byContentId.get(`content-${String(index).padStart(4, "0")}`)).toMatchObject({
				state: "leased",
			});
		}
		for (const lease of seeded.invalidLeases) {
			expect(byContentId.get(lease.contentId)).toMatchObject({
				state: "leased",
				lease_token: expect.any(String),
				work_version: 1,
			});
		}
		expect(rows.filter((row) => row.state === "leased")).toHaveLength(2_950);
	},
);

it("claims due work from a large mixed queue without excessive reads", async () => {
	const seeded = await seedWork("mixed", "pending", 50_000);
	const leasedIds = Array.from(
		{ length: 100 },
		(_, index) => `content-${String(index).padStart(4, "0")}`,
	);
	await sql`
		UPDATE _emdash_media_usage_work
		SET state = 'leased', lease_token = 'lease-' || content_id,
			lease_expires_at = '2099-01-01T00:00:00.000Z'
		WHERE collection_id = ${seeded.collectionId}
			AND content_id IN (SELECT value FROM json_each(${JSON.stringify(leasedIds)}))
	`.execute(adminDb);

	const measurement: Measurement = { rowsRead: 0 };
	const db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, measurement) }),
	});
	const repository = new MediaUsageWorkRepository(db);
	const claimed = await repository.claimDueWorkBatch({ limit: 100, leaseDurationSeconds: 60 });
	await db.destroy();

	const claimedIds = new Set(claimed.map((work) => work.contentId));
	expect(claimed).toHaveLength(100);
	expect(leasedIds.every((contentId) => !claimedIds.has(contentId))).toBe(true);
	expect(measurement.rowsRead).toBeLessThan(10_000);

	const leasedRows = await adminDb
		.selectFrom("_emdash_media_usage_work")
		.select(["content_id", "state"])
		.where("collection_id", "=", seeded.collectionId)
		.where("state", "=", "leased")
		.execute();
	expect(leasedRows).toHaveLength(200);
	expect(leasedRows.filter((row) => leasedIds.includes(row.content_id))).toHaveLength(100);
	expect(leasedRows.filter((row) => claimedIds.has(row.content_id))).toHaveLength(100);

	const transitionMeasurement: Measurement = { rowsRead: 0 };
	const transitionDb = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, transitionMeasurement) }),
	});
	const transitionRepository = new MediaUsageWorkRepository(transitionDb);
	const completed = await transitionRepository.completeWorkBatch([
		...claimed.map((work) => ({
			collectionId: work.collectionId,
			contentId: work.contentId,
			workVersion: work.workVersion,
			leaseToken: work.leaseToken!,
		})),
		...leasedIds.map((contentId) => ({
			collectionId: seeded.collectionId,
			contentId,
			workVersion: 1,
			leaseToken: `lease-${contentId}`,
		})),
	]);
	await transitionDb.destroy();

	expect(completed.size).toBe(200);
	expect(transitionMeasurement.rowsRead).toBeLessThan(10_000);

	const remaining = await adminDb
		.selectFrom("_emdash_media_usage_work")
		.select(({ fn }) => fn.countAll<number>().as("count"))
		.where("collection_id", "=", seeded.collectionId)
		.executeTakeFirstOrThrow();
	expect(remaining.count).toBe(49_800);
});

async function seedWork(
	operation: string,
	state: "leased" | "pending" = "leased",
	count = 3_000,
): Promise<SeededWork> {
	const collectionId = `d1-work-${operation}`;
	const collectionSlug = `${collectionId}-slug`;
	const validLeases = Array.from({ length: 50 }, (_, index) => ({
		collectionId,
		contentId: `content-${String(index).padStart(4, "0")}`,
		workVersion: 1,
		leaseToken: `lease-content-${String(index).padStart(4, "0")}`,
	}));
	const invalidLeases: MediaUsageWorkLease[] = [
		{
			collectionId,
			contentId: "content-2997",
			workVersion: 2,
			leaseToken: "lease-content-2997",
		},
		{
			collectionId,
			contentId: "content-2998",
			workVersion: 1,
			leaseToken: "wrong-token",
		},
		{
			collectionId,
			contentId: "content-2999",
			workVersion: 1,
			leaseToken: "lease-content-2999",
		},
	];
	const contentIds = Array.from(
		{ length: count },
		(_, index) => `content-${String(index).padStart(4, "0")}`,
	);
	const batchState = state === "leased" ? sql`'leased'` : sql`'pending'`;
	for (let offset = 0; offset < contentIds.length; offset += 1_000) {
		const batch = contentIds.slice(offset, offset + 1_000);
		await sql`
			INSERT INTO _emdash_media_usage_work
				(collection_id, collection_slug, content_id, change_epoch, work_version, state,
				 attempt_count, next_attempt_at, lease_token, lease_expires_at, last_attempted_at,
				 last_error_code, created_at, updated_at)
			SELECT ${collectionId}, ${collectionSlug}, value, 1, 1,
				${batchState}, 0, '2000-01-01T00:00:00.000Z',
				CASE WHEN ${state} = 'leased' THEN 'lease-' || value ELSE NULL END,
				CASE WHEN ${state} = 'leased' AND value = 'content-2999'
					THEN '2000-01-01T00:00:00.000Z'
					WHEN ${state} = 'leased' THEN '2099-01-01T00:00:00.000Z'
					ELSE NULL END,
				NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
			FROM json_each(${JSON.stringify(batch)})
		`.execute(adminDb);
	}
	return { collectionId, validLeases, invalidLeases };
}

function captureD1(database: D1Database, measurement: Measurement): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => captureStatement(target.prepare(query), measurement);
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function captureStatement(
	statement: D1PreparedStatement,
	measurement: Measurement,
): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property) {
			if (property === "bind") {
				return (...values: unknown[]) => captureStatement(target.bind(...values), measurement);
			}
			if (property === "all") {
				return async <T>() => {
					const result = await target.all<T>();
					measurement.rowsRead += result.meta.rows_read;
					return result;
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
