import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { describe, expect, it } from "vitest";

import { kyselyLogOption } from "../../src/database/instrumentation.js";
import { requestCached } from "../../src/request-cache.js";
import {
	createRequestMetrics,
	type RequestMetrics,
	runWithContext,
} from "../../src/request-context.js";

function freshKysely() {
	return new Kysely<Record<string, unknown>>({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
		log: kyselyLogOption(),
	});
}

async function withMetrics<T>(metrics: RequestMetrics, fn: () => Promise<T>): Promise<T> {
	return runWithContext({ editMode: false, metrics }, fn);
}

describe("request metrics — Kysely log hook", () => {
	it("counts queries and accumulates total duration", async () => {
		const db = freshKysely();
		const metrics = createRequestMetrics(performance.now());
		await withMetrics(metrics, async () => {
			await sql`SELECT 1`.execute(db);
			await sql`SELECT 2`.execute(db);
			await sql`SELECT 3`.execute(db);
		});
		expect(metrics.dbCount).toBe(3);
		expect(metrics.dbTotalMs).toBeGreaterThanOrEqual(0);
	});

	it("captures first and last query offsets", async () => {
		const db = freshKysely();
		const metrics = createRequestMetrics(performance.now());
		await withMetrics(metrics, async () => {
			await sql`SELECT 1`.execute(db);
			await new Promise((resolve) => setTimeout(resolve, 5));
			await sql`SELECT 2`.execute(db);
		});
		expect(metrics.dbFirstOffset).not.toBeNull();
		expect(metrics.dbLastOffset).not.toBeNull();
		expect(metrics.dbLastOffset!).toBeGreaterThan(metrics.dbFirstOffset!);
	});

	it("does nothing outside a request context", async () => {
		const db = freshKysely();
		const metrics = createRequestMetrics(performance.now());
		await sql`SELECT 1`.execute(db);
		expect(metrics.dbCount).toBe(0);
		expect(metrics.dbFirstOffset).toBeNull();
	});
});

describe("request metrics — request-cache", () => {
	it("counts misses on first lookup and hits on subsequent lookups", async () => {
		const metrics = createRequestMetrics(performance.now());
		await withMetrics(metrics, async () => {
			await requestCached("k", async () => "v");
			await requestCached("k", async () => "v");
			await requestCached("k", async () => "v");
			await requestCached("other", async () => "v");
		});
		expect(metrics.cacheMisses).toBe(2);
		expect(metrics.cacheHits).toBe(2);
	});

	it("does not bump counters when no metrics on context", async () => {
		const metrics = createRequestMetrics(performance.now());
		await runWithContext({ editMode: false }, async () => {
			await requestCached("k", async () => "v");
			await requestCached("k", async () => "v");
		});
		expect(metrics.cacheHits).toBe(0);
		expect(metrics.cacheMisses).toBe(0);
	});
});
