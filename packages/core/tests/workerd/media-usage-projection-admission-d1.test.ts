import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { createTestRuntime } from "../utils/mcp-runtime.js";
import {
	createMediaUsageAdmissionFixture,
	mediaUsageMeasurementData,
} from "../utils/media-usage-admission-fixture.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

interface CapturedD1Query {
	sql: string;
	binds: number;
	rowsRead: number;
	rowsWritten: number;
	durationMs: number;
}

let db: Kysely<Database>;
let captured: CapturedD1Query[];
let fixture: Awaited<ReturnType<typeof createMediaUsageAdmissionFixture>>;

beforeAll(async () => {
	setI18nConfig(null);
	captured = [];
	db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: captureD1(env.DB) }),
	});
	await runMigrations(db);
	fixture = await createMediaUsageAdmissionFixture(db, "admission_d1");
});

afterAll(async () => {
	setI18nConfig(null);
	await db.destroy();
});

it("reports real D1 metadata for the approved full runtime boundary", async () => {
	const runtime = createTestRuntime(db);
	const created = await runtime.handleContentCreate(fixture.collectionSlug, {
		slug: "boundary-d1",
		data: {
			title: "Boundary D1",
			...mediaUsageMeasurementData(0, "boundary-d1-live"),
		},
	});
	expect(created.success).toBe(true);
	if (!created.success) throw new Error(created.error.message);

	const measurement = await measure(() =>
		runtime.handleContentUpdate(fixture.collectionSlug, created.data.item.id, {
			data: mediaUsageMeasurementData(12, "boundary-d1-draft"),
		}),
	);
	expect(measurement.value.success).toBe(true);
	expect(measurement.d1Queries).toBeLessThanOrEqual(40);
	// The collection/source cleanup cursors add one index write for this source
	// and each of its 12 occurrences; keep the bound exact so further growth fails.
	expect(measurement.rowsWritten).toBeLessThanOrEqual(135);
	expect(measurement.maxBinds).toBeLessThanOrEqual(100);
	expect(measurement.maxSqlBytes).toBeLessThan(100 * 1024);
	const { value: _value, ...evidence } = measurement;
	console.info(`PR1_D1_MEASUREMENT=${JSON.stringify(evidence)}`);
});

async function measure<T>(operation: () => Promise<T>) {
	captured = [];
	const startedAt = performance.now();
	const value = await operation();
	await waitForDeferredTasks();
	return {
		value,
		d1Queries: captured.length,
		rowsRead: captured.reduce((total, query) => total + query.rowsRead, 0),
		rowsWritten: captured.reduce((total, query) => total + query.rowsWritten, 0),
		d1DurationMs: captured.reduce((total, query) => total + query.durationMs, 0),
		wallDurationMs: Number((performance.now() - startedAt).toFixed(3)),
		maxBinds: Math.max(0, ...captured.map((query) => query.binds)),
		maxSqlBytes: Math.max(
			0,
			...captured.map((query) => new TextEncoder().encode(query.sql).byteLength),
		),
	};
}

function captureD1(database: D1Database): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => captureStatement(target.prepare(query), query, 0);
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function captureStatement(
	statement: D1PreparedStatement,
	query: string,
	binds: number,
): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property) {
			if (property === "bind") {
				return (...values: unknown[]) =>
					captureStatement(target.bind(...values), query, values.length);
			}
			if (property === "all") {
				return async <T>() => {
					const result = await target.all<T>();
					captured.push({
						sql: query,
						binds,
						rowsRead: result.meta.rows_read,
						rowsWritten: result.meta.rows_written,
						durationMs: result.meta.duration,
					});
					return result;
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
