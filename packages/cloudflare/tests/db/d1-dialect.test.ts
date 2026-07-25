import { CompiledQuery, Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { EmDashD1Dialect, RawBindingD1Dialect } from "../../src/db/d1-dialect.js";

/**
 * Regression tests for #2040: with the default D1 config the singleton
 * Kysely serializes every query behind a ConnectionMutex (because
 * SqliteAdapter reports supportsMultipleConnections: false). When a request
 * is canceled mid-query on Workers the pending I/O promise never settles, so
 * releaseLock() never runs and every later obtainLock() waits forever — an
 * isolate-wide deadlock from a single canceled request.
 *
 * The fix scopes `supportsMultipleConnections: true` to the raw-binding
 * dialect (RawBindingD1Dialect) ONLY. The session-backed non-coalesce path
 * keeps the stock adapter (mutex), because a D1DatabaseSession advances its
 * bookmark per query and concurrent physical calls could interleave it.
 */

interface MockStatement {
	sql: string;
	params: unknown[];
	bind: (...params: unknown[]) => MockStatement;
	all: () => Promise<unknown>;
}

function createMockD1() {
	const allCalls: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const database = {
		prepare(sql: string): MockStatement {
			const stmt: MockStatement = {
				sql,
				params: [],
				bind(...params: unknown[]) {
					stmt.params = params;
					return stmt;
				},
				async all() {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					// Yield so a concurrent query can enter all() before this one
					// resolves — this is what lets maxInFlight measure overlap.
					await new Promise((resolve) => setTimeout(resolve, 5));
					inFlight--;
					allCalls.push(sql);
					return { success: true, results: [], meta: { changes: 0, last_row_id: 0 } };
				},
			};
			return stmt;
		},
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mock implements the prepare/batch subset the dialect uses
	const db = database as unknown as D1Database;
	return {
		database: db,
		allCalls,
		maxInFlight: () => maxInFlight,
	};
}

describe("RawBindingD1Dialect (#2040)", () => {
	it("reports supportsMultipleConnections: true so no ConnectionMutex serializes queries", () => {
		const { database } = createMockD1();
		const dialect = new RawBindingD1Dialect({ database });
		expect(dialect.createAdapter().supportsMultipleConnections).toBe(true);
	});

	it("lets concurrent queries overlap instead of serializing behind a mutex", async () => {
		const { database, allCalls, maxInFlight } = createMockD1();
		const db = new Kysely<any>({ dialect: new RawBindingD1Dialect({ database }) });

		// With the mutex (supportsMultipleConnections: false) the second query
		// cannot reach the binding until the first resolves: maxInFlight would
		// stay 1. Without it, both overlap: maxInFlight reaches 2. This is what
		// actually proves the deadlock class is gone (a canceled first query no
		// longer blocks a later one).
		await Promise.all([
			db.executeQuery(CompiledQuery.raw("select 1")),
			db.executeQuery(CompiledQuery.raw("select 2")),
		]);

		expect(maxInFlight()).toBe(2);
		expect(allCalls).toHaveLength(2);
	});
});

describe("EmDashD1Dialect (session path keeps the mutex)", () => {
	it("still reports supportsMultipleConnections: false", () => {
		const { database } = createMockD1();
		const dialect = new EmDashD1Dialect({ database });
		// The session-backed non-coalesce path must keep Kysely's serialization:
		// a D1DatabaseSession advances its bookmark per executed query, and
		// concurrent physical calls could interleave it and persist a stale
		// bookmark at commit(), breaking read-your-writes.
		expect(dialect.createAdapter().supportsMultipleConnections).toBe(false);
	});

	it("serializes concurrent queries (maxInFlight stays 1)", async () => {
		const { database, maxInFlight } = createMockD1();
		const db = new Kysely<any>({ dialect: new EmDashD1Dialect({ database }) });

		await Promise.all([
			db.executeQuery(CompiledQuery.raw("select 1")),
			db.executeQuery(CompiledQuery.raw("select 2")),
		]);

		expect(maxInFlight()).toBe(1);
	});
});
