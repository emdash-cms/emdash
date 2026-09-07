import { afterEach, describe, expect, it, vi } from "vitest";

import { createD1SessionGuard } from "../../src/db/d1-session-guard.js";

/** Short timeout so hang tests stay fast. */
const TIMEOUT_MS = 25;

interface MockD1Options {
	/** When true, every statement execution returns a promise that never settles. */
	hang?: boolean;
	/** When set, every statement execution rejects with this error. */
	error?: Error;
	rows?: Record<string, unknown>[];
}

function d1Result(rows: Record<string, unknown>[]) {
	return {
		success: true as const,
		results: rows,
		meta: { changes: 0, last_row_id: 0 },
	};
}

/**
 * Minimal mock of the D1Database subset the guard wraps (prepare/batch and
 * the statement methods). Records executed SQL so tests can assert which
 * binding (session vs fallback) actually served a query.
 */
function createMockD1(options: MockD1Options = {}) {
	const executed: string[] = [];
	const batches: string[][] = [];

	function makeStatement(sql: string) {
		const statement = {
			sql,
			params: [] as unknown[],
			bind(...params: unknown[]) {
				statement.params = params;
				return statement;
			},
			all: () => run(),
			run: () => run(),
			raw: () => run().then(() => []),
			first: () => run().then(() => null),
		};
		function run(): Promise<ReturnType<typeof d1Result>> {
			executed.push(sql);
			if (options.hang) return new Promise(() => undefined);
			if (options.error) return Promise.reject(options.error);
			return Promise.resolve(d1Result(options.rows ?? []));
		}
		return statement;
	}

	const database = {
		prepare: (sql: string) => makeStatement(sql),
		batch: (statements: Array<{ sql: string }>) => {
			batches.push(statements.map((s) => s.sql));
			if (options.hang) return new Promise(() => undefined);
			if (options.error) return Promise.reject(options.error);
			return Promise.resolve(statements.map(() => d1Result(options.rows ?? [])));
		},
	};

	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- structurally covers the D1Database subset the guard uses
	return { database: database as unknown as D1Database, executed, batches };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createD1SessionGuard", () => {
	it("passes healthy session queries through and never latches broken", async () => {
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ rows: [{ id: 1 }] });
		const fallback = createMockD1();

		const db = guard.wrap(session.database, fallback.database);
		const result = await db.prepare("select * from posts").bind().all();

		expect(result.results).toEqual([{ id: 1 }]);
		expect(session.executed).toEqual(["select * from posts"]);
		expect(fallback.executed).toEqual([]);
		expect(guard.isBroken()).toBe(false);
	});

	it("falls back to the direct binding when a SELECT hangs, and latches broken", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ hang: true });
		const fallback = createMockD1({ rows: [{ id: 7 }] });

		const db = guard.wrap(session.database, fallback.database);
		const result = await db.prepare("select * from posts").bind(1).all();

		expect(result.results).toEqual([{ id: 7 }]);
		expect(session.executed).toEqual(["select * from posts"]);
		expect(fallback.executed).toEqual(["select * from posts"]);
		expect(guard.isBroken()).toBe(true);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(errorSpy.mock.calls[0]?.[0]).toContain("global_fetch_strictly_public");
	});

	it("refuses to re-run a hung non-SELECT on the direct binding", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ hang: true });
		const fallback = createMockD1();

		const db = guard.wrap(session.database, fallback.database);
		await expect(db.prepare("update posts set title = ?").bind("x").run()).rejects.toThrow(
			/non-SELECT/,
		);

		expect(fallback.executed).toEqual([]);
		expect(guard.isBroken()).toBe(true);
	});

	it("re-runs a hung all-SELECT batch on the direct binding", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ hang: true });
		const fallback = createMockD1({ rows: [{ n: 1 }] });

		const db = guard.wrap(session.database, fallback.database);
		const statements = [
			db.prepare("select * from a").bind(),
			db.prepare("select * from b").bind(1),
		];
		const results = await db.batch(statements);

		expect(results).toHaveLength(2);
		expect(results[0]?.results).toEqual([{ n: 1 }]);
		expect(fallback.batches).toEqual([["select * from a", "select * from b"]]);
		expect(guard.isBroken()).toBe(true);
	});

	it("rejects a hung batch containing a write instead of re-running it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ hang: true });
		const fallback = createMockD1();

		const db = guard.wrap(session.database, fallback.database);
		const statements = [db.prepare("select * from a").bind(), db.prepare("delete from b").bind()];
		await expect(db.batch(statements)).rejects.toThrow(/non-SELECT/);

		expect(fallback.batches).toEqual([]);
		expect(guard.isBroken()).toBe(true);
	});

	it("treats a settled SQL error as proof of a healthy transport", async () => {
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ error: new Error("no such table: posts") });
		const fallback = createMockD1();

		const db = guard.wrap(session.database, fallback.database);
		await expect(db.prepare("select * from posts").bind().all()).rejects.toThrow(/no such table/);

		expect(guard.isBroken()).toBe(false);
		expect(fallback.executed).toEqual([]);
	});

	it("skips the race entirely once a query has settled successfully", async () => {
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const healthy = createMockD1({ rows: [] });
		const fallback = createMockD1();
		const db = guard.wrap(healthy.database, fallback.database);
		await db.prepare("select 1").bind().all();

		// A slow-but-not-raced query after the healthy latch: hang the session
		// and confirm the guard no longer intervenes within the timeout window.
		const hanging = createMockD1({ hang: true });
		const db2 = guard.wrap(hanging.database, fallback.database);
		const pending = db2.prepare("select 2").bind().all();
		const raced = await Promise.race([
			pending.then(() => "settled"),
			new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 3, "still pending")),
		]);

		expect(raced).toBe("still pending");
		expect(guard.isBroken()).toBe(false);
		expect(fallback.executed).toEqual([]);
	});

	it("skips the timeout entirely once latched broken (fast path)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ hang: true });
		const fallback = createMockD1({ rows: [{ id: 1 }] });

		// Trip the latch with one hanging SELECT.
		const latchDb = guard.wrap(session.database, fallback.database);
		await latchDb.prepare("select 1").bind().all();
		expect(guard.isBroken()).toBe(true);

		// A db created before or after the latch must not race again: measure
		// that the fallback answers well below the guard timeout.
		const db = guard.wrap(session.database, fallback.database);
		const started = performance.now();
		const result = await db.prepare("select * from posts").bind().all();
		await expect(db.prepare("update posts set x = 1").bind().run()).rejects.toThrow(/non-SELECT/);
		const batchResults = await db.batch([
			db.prepare("select * from a").bind(),
			db.prepare("select * from b").bind(),
		]);
		const elapsed = performance.now() - started;

		expect(result.results).toEqual([{ id: 1 }]);
		expect(batchResults).toHaveLength(2);
		expect(fallback.batches).toEqual([["select * from a", "select * from b"]]);
		// Three operations after the latch; racing would cost >= TIMEOUT_MS each.
		expect(elapsed).toBeLessThan(TIMEOUT_MS);
		// Only the latching query hit the (hanging) session.
		expect(session.executed).toEqual(["select 1"]);
	});

	it("supports first() and raw() on the guarded statement", async () => {
		const guard = createD1SessionGuard(TIMEOUT_MS);
		const session = createMockD1({ rows: [] });
		const fallback = createMockD1();

		const db = guard.wrap(session.database, fallback.database);
		await expect(db.prepare("select 1").bind().first()).resolves.toBeNull();
		await expect(db.prepare("select 1").bind().raw()).resolves.toEqual([]);
		expect(session.executed).toEqual(["select 1", "select 1"]);
	});
});
