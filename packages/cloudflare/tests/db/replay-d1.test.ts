import { CompiledQuery, Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";

import {
	ReplayD1Dialect,
	type ReplayCounters,
	type ReplayOptions,
} from "../../src/db/replay-d1.js";
import type { ReplayPlan } from "../../src/db/replay-plan-store.js";

interface MockStatement {
	sql: string;
	params: unknown[];
	bind: (...params: unknown[]) => MockStatement;
	all: () => Promise<unknown>;
}

/** D1 subset (prepare/batch) whose rows are a fresh copy per call. */
function createMockD1(rowsBySql: Record<string, Record<string, unknown>[]> = {}) {
	const operations: string[] = [];
	const batchCalls: MockStatement[][] = [];
	let failBatches = false;
	let batchGate: Promise<void> | undefined;

	function d1Result(stmt: MockStatement) {
		if (stmt.sql.includes("missing_table")) throw new Error("no such table: missing_table");
		return {
			success: true,
			results: structuredClone(rowsBySql[stmt.sql] ?? []),
			meta: { changes: 0, last_row_id: 0, rows_read: 1 },
		};
	}

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
					operations.push(`all:${stmt.sql}`);
					return d1Result(stmt);
				},
			};
			return stmt;
		},
		async batch(statements: MockStatement[]) {
			operations.push(`batch:${statements.map((s) => s.sql).join("|")}`);
			batchCalls.push(statements);
			await batchGate;
			if (failBatches) throw new Error("D1_ERROR: batch failed");
			return statements.map((s) => d1Result(s));
		},
	};
	return {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mock implements the prepare/batch subset the dialect uses
		database: database as unknown as D1Database,
		operations,
		batchCalls,
		failNextBatches: () => {
			failBatches = true;
		},
		holdBatches: () => {
			let release = () => {};
			batchGate = new Promise((resolve) => {
				release = resolve;
			});
			return release;
		},
	};
}

function plan(...statements: Array<[string, ...Array<string | number | null>]>): ReplayPlan {
	return { v: 1, statements: statements.map(([sql, ...params]) => ({ sql, params })) };
}

function setup(
	mock: ReturnType<typeof createMockD1>,
	planned: ReplayOptions["plan"],
	extra: Partial<ReplayOptions> = {},
) {
	const counters: ReplayCounters = { hits: 0, misses: 0, waste: 0 };
	const onRpc = vi.fn();
	const dialect = new ReplayD1Dialect(
		{ database: mock.database, onRpc },
		{ plan: planned, counters, ...extra },
	);
	const db = new Kysely<any>({ dialect });
	const select = (sql: string, ...params: unknown[]) =>
		db.executeQuery<Record<string, unknown>>(CompiledQuery.raw(sql, params));
	return { db, dialect, counters, onRpc, select };
}

describe("ReplayD1Connection", () => {
	it("serves every planned query from one batch round trip", async () => {
		const mock = createMockD1({ "select a": [{ a: 1 }], "select b where id = ?": [{ b: 2 }] });
		const { select, counters, onRpc, dialect } = setup(
			mock,
			plan(["select a"], ["select b where id = ?", 7]),
		);

		const a = await select("select a");
		const b = await select("select b where id = ?", 7);

		expect(a.rows).toEqual([{ a: 1 }]);
		expect(b.rows).toEqual([{ b: 2 }]);
		expect(mock.operations).toEqual(["batch:select a|select b where id = ?"]);
		expect(mock.batchCalls[0]?.[1]?.params).toEqual([7]);
		expect(onRpc).toHaveBeenCalledTimes(1);
		expect(onRpc).toHaveBeenCalledWith(2);
		expect(counters).toEqual({ hits: 2, misses: 0, waste: 0 });
		expect(dialect.finish()).toEqual({ nextPlan: null, failed: false, hadPlan: true });
	});

	it("takes the normal path for everything when there is no plan, and learns", async () => {
		const mock = createMockD1({ "select a": [{ a: 1 }] });
		const { select, counters, dialect } = setup(mock, null);

		await select("select a");
		await select("select b where id = ?", "x");

		expect(mock.operations).toEqual(["all:select a", "all:select b where id = ?"]);
		expect(counters).toEqual({ hits: 0, misses: 2, waste: 0 });
		expect(dialect.finish()).toEqual({
			nextPlan: plan(["select a"], ["select b where id = ?", "x"]),
			failed: false,
			hadPlan: false,
		});
	});

	it("matches on params as well as sql", async () => {
		const mock = createMockD1({ "select b where id = ?": [{ b: 2 }] });
		const { select, counters } = setup(mock, plan(["select b where id = ?", 1]));

		await select("select b where id = ?", 2);

		expect(mock.operations).toEqual(["batch:select b where id = ?", "all:select b where id = ?"]);
		expect(counters).toEqual({ hits: 0, misses: 1, waste: 1 });
	});

	it("handles a partial plan: hits, misses and waste, then rewrites it", async () => {
		const mock = createMockD1({ "select a": [{ a: 1 }], "select c": [{ c: 3 }] });
		const { select, counters, dialect } = setup(
			mock,
			plan(["select a"], ["select b"], ["select z"]),
		);

		await select("select a");
		await select("select c");

		expect(counters).toEqual({ hits: 1, misses: 1, waste: 2 });
		// Most of the plan went unused, so the new plan is what ran.
		expect(dialect.finish()).toEqual({
			nextPlan: plan(["select a"], ["select c"]),
			failed: false,
			hadPlan: true,
		});
	});

	it("keeps unused entries when the render also ran something unplanned", async () => {
		const mock = createMockD1();
		const { select, dialect } = setup(mock, plan(["select a"], ["select b"], ["select z"]));

		await select("select a");
		await select("select b");
		await select("select c");

		expect(dialect.finish()?.nextPlan).toEqual(
			plan(["select a"], ["select b"], ["select c"], ["select z"]),
		);
	});

	it("writes nothing when only some planned entries went unused", async () => {
		const mock = createMockD1();
		const { select, dialect } = setup(mock, plan(["select a"], ["select b"], ["select z"]));

		await select("select a");
		await select("select b");

		expect(dialect.finish()?.nextPlan).toBeNull();
	});

	it("serves repeated identical queries from one statement, each with its own rows", async () => {
		const mock = createMockD1({ "select a": [{ a: 1, nested: { n: 1 } }] });
		const { select, counters } = setup(mock, plan(["select a"]));

		const first = await select("select a");
		(first.rows[0] as { nested: { n: number } }).nested.n = 99;
		first.rows.push({ a: 2 });
		const second = await select("select a");

		expect(second.rows).toEqual([{ a: 1, nested: { n: 1 } }]);
		expect(mock.operations).toEqual(["batch:select a"]);
		expect(counters).toEqual({ hits: 2, misses: 0, waste: 0 });
	});

	it("clears the memo on any write so later reads see it", async () => {
		const mock = createMockD1({ "select a": [{ a: 1 }] });
		const { select, db, counters } = setup(mock, plan(["select a"]));

		await select("select a");
		await db.executeQuery(CompiledQuery.raw("update a set x = ?", [1]));
		await select("select a");

		expect(mock.operations).toEqual(["batch:select a", "all:update a set x = ?", "all:select a"]);
		expect(counters).toEqual({ hits: 1, misses: 1, waste: 0 });
	});

	it.each([
		["a CTE write", "with x as (select 1) delete from a", 1],
		["a read-only CTE", "with x as (select 1) select * from x", 2],
	])("after %s, serves planned reads accordingly", async (_name, sql, hits) => {
		const mock = createMockD1({ "select a": [{ a: 1 }] });
		const { select, db, counters } = setup(mock, plan(["select a"]));

		await select("select a");
		await db.executeQuery(CompiledQuery.raw(sql));
		await select("select a");

		expect(counters.hits).toBe(hits);
	});

	it("discards a batch that a write overtook while it was in flight", async () => {
		const mock = createMockD1({ "select a": [{ a: 1 }] });
		const release = mock.holdBatches();
		const { select, db, counters } = setup(mock, plan(["select a"]));

		const read = select("select a");
		await vi.waitFor(() => expect(mock.batchCalls).toHaveLength(1));
		const write = db.executeQuery(CompiledQuery.raw("delete from a"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		await Promise.all([read, write]);

		// The read was issued before the write but is answered after it.
		expect(mock.operations).toEqual(["batch:select a", "all:delete from a", "all:select a"]);
		expect(counters).toEqual({ hits: 0, misses: 1, waste: 1 });
	});

	it("drops the plan when the batch rejects and serves the render normally", async () => {
		const mock = createMockD1({ "select a": [{ a: 1 }] });
		mock.failNextBatches();
		const onBatchFailed = vi.fn();
		const { select, counters, dialect } = setup(mock, plan(["select a"], ["select b"]), {
			onBatchFailed,
		});

		const a = await select("select a");

		expect(a.rows).toEqual([{ a: 1 }]);
		expect(onBatchFailed).toHaveBeenCalledTimes(1);
		expect(counters.hits).toBe(0);
		expect(counters.misses).toBe(1);
		expect(dialect.finish()).toEqual({
			nextPlan: plan(["select a"]),
			failed: true,
			hadPlan: true,
		});
	});

	it("never records a query that failed", async () => {
		const mock = createMockD1();
		const { select, dialect } = setup(mock, null);

		await select("select a");
		await expect(select("select * from missing_table")).rejects.toThrow(/no such table/);

		expect(dialect.finish()?.nextPlan).toEqual(plan(["select a"]));
	});

	it.each([
		["a write", "delete from a"],
		["a CTE", "with x as (select 1) delete from a"],
		["a second statement", "select 1; delete from a"],
	])("ignores a plan containing %s", async (_name, sql) => {
		const mock = createMockD1();
		const { select, counters } = setup(mock, plan(["select a"], [sql]));

		await select("select a");

		expect(mock.batchCalls).toHaveLength(0);
		expect(mock.operations).toEqual(["all:select a"]);
		expect(counters.waste).toBe(0);
	});

	it("neither records nor serves queries with non-primitive params", async () => {
		const mock = createMockD1();
		const { db, dialect } = setup(mock, null);

		await db.executeQuery(CompiledQuery.raw("select a where b = ?", [new Uint8Array([1])]));

		expect(dialect.finish()?.nextPlan).toBeNull();
	});

	it("stops recording once finished", async () => {
		const mock = createMockD1();
		const { select, dialect } = setup(mock, null);

		await select("select a");
		dialect.finish();
		await select("select late");

		expect(mock.operations).toEqual(["all:select a", "all:select late"]);
	});
});
