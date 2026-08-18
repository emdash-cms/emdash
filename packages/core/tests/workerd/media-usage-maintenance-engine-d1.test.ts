import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { installMediaUsageCaptureTriggers } from "../../src/media/usage/capture-triggers.js";
import { runMediaUsageMaintenanceStep } from "../../src/media/usage/maintenance-engine.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

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

it("keeps two idle classes plus one useful D1 unit below the hard query boundary", async () => {
	const registry = new SchemaRegistry(adminDb);
	await registry.createCollection({ slug: "d1_engine_work", label: "D1 engine work" });
	await registry.createField("d1_engine_work", {
		slug: "title",
		label: "Title",
		type: "string",
	});
	const collection = await registry.getCollection("d1_engine_work");
	if (!collection) throw new Error("Expected D1 engine collection");
	await adminDb
		.updateTable("_emdash_media_usage_index_status")
		.set({
			collection_id: collection.id,
			status: "complete",
			capture_state: "installing",
			reconciliation_required: 0,
		})
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", collection.slug)
		.execute();
	await installMediaUsageCaptureTriggers(adminDb, {
		collectionId: collection.id,
		collectionSlug: collection.slug,
	});
	await adminDb
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", media_usage_maintenance_turn: 0 })
		.where("task_key", "=", "incremental_capture")
		.execute();
	await sql`
		INSERT INTO ${sql.ref("ec_d1_engine_work")} (id, slug, status, title)
		VALUES ('entry-1', 'entry-1', 'published', 'Entry 1')
	`.execute(adminDb);

	const measurement = emptyMeasurement();
	const db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: captureD1(env.DB, measurement) }),
	});
	const startedAt = performance.now();
	const result = await runMediaUsageMaintenanceStep(db);
	measurement.wallDurationMs = Number((performance.now() - startedAt).toFixed(3));
	await db.destroy();

	expect(result).toEqual({
		state: "progress",
		continuation: { kind: "immediate" },
		taskClass: "entry_work",
		turn: 0,
	});
	expect(measurement.queries).toBeLessThan(50);
	expect(measurement.maxBinds).toBeLessThanOrEqual(100);
	expect(measurement.maxSqlBytes).toBeLessThan(100 * 1024);
	expect(measurement.wallDurationMs).toBeLessThan(2_500);
	console.info(`PR8_D1_MAINTENANCE_STEP=${JSON.stringify(measurement)}`);
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
