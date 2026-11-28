import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { kyselyLogOption } from "../../src/database/instrumentation.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../src/database/repositories/media-usage.js";
import type { Database } from "../../src/database/types.js";
import { refreshContentMediaUsage } from "../../src/media/usage/content-refresh.js";
import {
	repairContentMediaUsageAll,
	repairContentMediaUsageCollection,
} from "../../src/media/usage/content-repair.js";
import { extractMediaUsageOccurrences } from "../../src/media/usage/extractor.js";
import {
	MEDIA_USAGE_MAINTENANCE_LIMITS,
	runMediaUsageMaintenanceStep,
} from "../../src/media/usage/maintenance-engine.js";
import { createRequestMetrics, runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	createMediaUsageAdmissionFixture,
	insertMediaUsageMeasurementEntry,
	mediaUsageMeasurementData,
} from "../utils/media-usage-admission-fixture.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

interface D1Measurement {
	queries: number;
	rowsRead: number;
	rowsWritten: number;
	durationMs: number;
	wallDurationMs: number;
	maxBinds: number;
	maxSqlBytes: number;
}

let adminDb: Kysely<Database>;

beforeAll(async () => {
	adminDb = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: env.DB }),
	});
	await runMigrations(adminDb);
});

afterAll(async () => {
	await adminDb.destroy();
});

it("extracts HTML media links in workerd with attributes, entities, and deduped indices", () => {
	const occurrences = extractMediaUsageOccurrences({
		fields: [{ slug: "body", type: "portableText" }],
		data: {
			body: [
				{
					_type: "htmlBlock",
					_key: "html-links",
					html:
						'<a class="download" href="/_emdash/api/media/file/01KHTMLPDF.pdf?download=1&amp;source=body">PDF &amp; details</a>' +
						'<img class="preview" src="/_emdash/api/media/file/01KHTMLIMAGE.png" alt="A &amp; B">' +
						'<img src="/_emdash/api/media/file/01KHTMLIMAGE.png">',
				},
			],
		},
	});

	expect(occurrences).toEqual([
		expect.objectContaining({
			fieldPath: "body[0].html",
			occurrenceIndex: 0,
			referenceType: "link",
			providerAssetId: "01KHTMLPDF.pdf",
			storageKey: "01KHTMLPDF.pdf",
		}),
		expect.objectContaining({
			fieldPath: "body[0].html",
			occurrenceIndex: 1,
			referenceType: "link",
			providerAssetId: "01KHTMLIMAGE.png",
			storageKey: "01KHTMLIMAGE.png",
		}),
	]);
});

it("keeps full-repair source lookups within D1 value limits", async () => {
	const collectionId = "collection-" + "x".repeat(40);
	const sourceKeys = Array.from(
		{ length: 50_000 },
		(_, index) => `content:${collectionId}:${String(index).padStart(8, "0")}:draft_overlay`,
	);

	await expect(new MediaUsageRepository(adminDb).findSources(sourceKeys)).resolves.toEqual(
		new Map(),
	);
});

it("keeps the largest entry step below the shared reservation", async () => {
	const fixture = await createMediaUsageAdmissionFixture(adminDb, "d1_engine_boundary");
	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active" })
		.where("task_key", "=", "incremental_capture")
		.execute();
	await insertMediaUsageMeasurementEntry(
		adminDb,
		fixture,
		"boundary-entry",
		mediaUsageMeasurementData(500, "boundary-entry"),
	);

	const measurement = emptyMeasurement();
	const db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, measurement) }),
		log: kyselyLogOption(),
	});
	const startedAt = performance.now();
	const result = await runMediaUsageMaintenanceStep(db);
	measurement.wallDurationMs = Number((performance.now() - startedAt).toFixed(3));
	await db.destroy();

	expect(result).toEqual({
		state: "progress",
		continuation: { kind: "immediate" },
	});
	expect(measurement.queries).toBeLessThanOrEqual(MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries);
	expect(measurement.maxBinds).toBeLessThanOrEqual(100);
	expect(measurement.maxSqlBytes).toBeLessThan(100 * 1024);
	expect(measurement.wallDurationMs).toBeLessThan(5_000);
	console.info(`PR8_D1_MAINTENANCE_STEP=${JSON.stringify(measurement)}`);
});

it("bounds a large content repair and preserves its partial status", async () => {
	const slug = `d1_repair_${Date.now().toString(36)}`;
	const collection = await seedRepairCollection(slug, 180, 1);
	const { db, measurement, metrics } = instrumentedD1();
	const result = await runWithContext({ editMode: false, metrics }, () =>
		repairContentMediaUsageCollection(db, { collectionSlug: slug }),
	);
	await db.destroy();

	const status = await adminDb
		.selectFrom("_emdash_media_usage_index_status")
		.select(["status", "indexed_source_count", "last_error_code"])
		.where("collection_id", "=", collection.id)
		.executeTakeFirstOrThrow();
	const writes = await adminDb
		.selectFrom("_emdash_media_usage_generation_writes")
		.selectAll()
		.execute();

	expect(result.status).toBe("partial");
	expect(result.indexedSourceCount).toBeGreaterThan(0);
	expect(result.indexedSourceCount).toBeLessThan(180);
	expect(result.lastErrorCode).toBe("CONTENT_USAGE_QUERY_LIMIT");
	expect(status).toMatchObject({
		status: "partial",
		indexed_source_count: result.indexedSourceCount,
		last_error_code: "CONTENT_USAGE_QUERY_LIMIT",
	});
	expect(writes).toHaveLength(0);
	expect(measurement.queries).toBeLessThan(900);
	expect(metrics.dbCount).toBe(measurement.queries);
});

it("does not apply the repair reservation to an ordinary usage refresh", async () => {
	const slug = `d1_refresh_${Date.now().toString(36)}`;
	await seedRepairCollection(slug, 1, 1);
	const { db, metrics } = instrumentedD1();
	metrics.dbCount = 740;

	const result = await runWithContext({ editMode: false, metrics }, () =>
		refreshContentMediaUsage(db, slug, `${slug}-0`),
	);

	expect(result.success).toBe(true);
	expect(await new MediaUsageRepository(db).findCurrentUsageByMediaId(`${slug}-0-0`)).toHaveLength(
		1,
	);
	await db.destroy();
});

it("rejects an oversized source before leasing or promoting it", async () => {
	const slug = `d1_huge_repair_${Date.now().toString(36)}`;
	const collection = await seedRepairCollection(slug, 1, 5_501);
	const { db, measurement, metrics } = instrumentedD1();
	const result = await runWithContext({ editMode: false, metrics }, () =>
		repairContentMediaUsageCollection(db, { collectionSlug: slug }),
	);
	await db.destroy();

	const status = await adminDb
		.selectFrom("_emdash_media_usage_index_status")
		.select(["status", "indexed_source_count", "last_error_code"])
		.where("collection_id", "=", collection.id)
		.executeTakeFirstOrThrow();
	const writes = await adminDb
		.selectFrom("_emdash_media_usage_generation_writes")
		.selectAll()
		.execute();
	const sources = await adminDb
		.selectFrom("_emdash_media_usage_sources")
		.selectAll()
		.where("collection_id", "=", collection.id)
		.execute();

	expect(result.status).toBe("failed");
	expect(result.indexedSourceCount).toBe(0);
	expect(result.lastErrorCode).toBe("CONTENT_USAGE_QUERY_LIMIT");
	expect(status).toMatchObject({ status: "failed", indexed_source_count: 0 });
	expect(status.last_error_code).toBe("CONTENT_USAGE_QUERY_LIMIT");
	expect(writes).toHaveLength(0);
	expect(sources).toHaveLength(0);
	expect(measurement.queries).toBeLessThan(900);
	expect(metrics.dbCount).toBe(measurement.queries);
});

it("keeps an all-collection repair within the request query budget", async () => {
	const suffix = Date.now().toString(36);
	await seedRepairCollection(`d1_all_a_${suffix}`, 180, 1);
	await seedRepairCollection(`d1_all_b_${suffix}`, 180, 1);
	const { db, measurement, metrics } = instrumentedD1();
	const result = await runWithContext({ editMode: false, metrics }, () =>
		repairContentMediaUsageAll(db),
	);
	await db.destroy();

	expect(result.status).toBe("partial");
	expect(
		result.collections.some(
			(collection) => collection.lastErrorCode === "CONTENT_USAGE_QUERY_LIMIT",
		),
	).toBe(true);
	expect(measurement.queries).toBeLessThan(900);
	expect(metrics.dbCount).toBe(measurement.queries);
});

it("does not count sources as failed when their collections were never started", async () => {
	const suffix = Date.now().toString(36);
	await seedRepairCollection(`d1_unstarted_a_${suffix}`, 1, 1);
	await seedRepairCollection(`d1_unstarted_b_${suffix}`, 1, 1);
	const { db, measurement, metrics } = instrumentedD1();
	metrics.dbCount = 900;

	const result = await runWithContext({ editMode: false, metrics }, () =>
		repairContentMediaUsageAll(db),
	);
	await db.destroy();

	expect(result.status).toBe("failed");
	expect(result.indexedSourceCount).toBe(0);
	expect(result.failedSourceCount).toBe(0);
	expect(result.collections.length).toBeGreaterThanOrEqual(2);
	for (const collection of result.collections) {
		expect(collection).toMatchObject({
			status: "failed",
			failedSourceCount: 0,
			lastErrorCode: "CONTENT_USAGE_QUERY_LIMIT",
		});
	}
	expect(measurement.rowsWritten).toBe(0);
});

async function seedRepairCollection(slug: string, count: number, occurrences: number) {
	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active" })
		.where("task_key", "=", "incremental_capture")
		.execute();
	const registry = new SchemaRegistry(adminDb);
	const collection = await registry.createCollection({ slug, label: slug });
	await registry.createField(slug, { slug: "body", label: "Body", type: "portableText" });
	const filler = "Portable text filler ".repeat(220);
	for (let index = 0; index < count; index++) {
		const body: Array<Record<string, unknown>> = Array.from(
			{ length: occurrences },
			(_, occurrence) => ({
				_type: "image",
				_key: `${index}-${occurrence}`,
				asset: { _ref: `${slug}-${index}-${occurrence}` },
			}),
		);
		body.unshift({
			_type: "block",
			_key: `${index}-text`,
			children: [{ _type: "span", text: filler }],
		});
		await sql`
			INSERT INTO ${sql.ref(`ec_${slug}`)} (id, slug, status, body)
			VALUES (${`${slug}-${index}`}, ${`${slug}-${index}`}, 'published', ${JSON.stringify(body)})
		`.execute(adminDb);
	}
	return collection;
}

function instrumentedD1() {
	const measurement = emptyMeasurement();
	const db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, measurement) }),
		log: kyselyLogOption(),
	});
	return { db, measurement, metrics: createRequestMetrics(performance.now()) };
}

it("keeps the largest admitted activation trigger replacement inside one step", async () => {
	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({
			state: "expanded",
			collection_cursor: null,
			drain_confirmed_at: null,
			lease_token: null,
			lease_expires_at: null,
			last_error_code: null,
		})
		.where("task_key", "=", "incremental_capture")
		.execute();
	const collection = await new SchemaRegistry(adminDb).createCollection({
		slug: "aaa_d1_activation_bound",
		label: "Activation bound",
	});
	for (let index = 0; index < 100; index++) {
		const triggerName = `emdash_mu_bound_${String(index).padStart(3, "0")}`;
		await sql`
			CREATE TRIGGER ${sql.ref(triggerName)}
			AFTER INSERT ON ${sql.ref("ec_aaa_d1_activation_bound")}
			BEGIN
				SELECT 1;
			END
		`.execute(adminDb);
	}
	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({
			state: "activating",
			drain_confirmed_at: "2026-08-18T12:00:00.000Z",
		})
		.where("task_key", "=", "incremental_capture")
		.execute();

	const measurement = emptyMeasurement();
	const db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, measurement) }),
		log: kyselyLogOption(),
	});
	const metrics = createRequestMetrics(performance.now());
	const result = await runWithContext({ editMode: false, metrics }, () =>
		runMediaUsageMaintenanceStep(db),
	);
	const status = await adminDb
		.selectFrom("_emdash_media_usage_index_status")
		.select("capture_state")
		.where("collection_id", "=", collection.id)
		.executeTakeFirstOrThrow();
	await db.destroy();

	expect(result).toEqual({
		state: "progress",
		continuation: { kind: "immediate" },
	});
	expect(status.capture_state).toBe("active");
	expect(measurement.queries).toBeLessThanOrEqual(MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries);
	expect(metrics.dbCount).toBe(measurement.queries);
});

function emptyMeasurement(): D1Measurement {
	return {
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
		durationMs: 0,
		wallDurationMs: 0,
		maxBinds: 0,
		maxSqlBytes: 0,
	};
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
					measurement.queries++;
					measurement.maxBinds = Math.max(measurement.maxBinds, binds.length);
					measurement.maxSqlBytes = Math.max(
						measurement.maxSqlBytes,
						new TextEncoder().encode(query).byteLength,
					);
					const result = await target.all<T>();
					measurement.rowsRead += result.meta.rows_read;
					measurement.rowsWritten += result.meta.rows_written;
					measurement.durationMs += result.meta.duration;
					return result;
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
