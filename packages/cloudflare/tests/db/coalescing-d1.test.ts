import { CompiledQuery, Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { CoalescingD1Dialect } from "../../src/db/coalescing-d1.js";

interface MockResultConfig {
	rows?: Record<string, unknown>[];
	changes?: number;
	lastRowId?: number;
	error?: Error;
}

interface MockStatement {
	sql: string;
	params: unknown[];
	bind: (...params: unknown[]) => MockStatement;
	all: () => Promise<unknown>;
}

/**
 * Hand-rolled mock of the D1Database subset the dialect uses (prepare/batch).
 * Records every `all()` and `batch()` call (and their order) so tests can
 * assert exactly which statements were coalesced.
 */
function createMockD1(resultsBySql: Record<string, MockResultConfig> = {}) {
	const operations: string[] = [];
	const batchCalls: MockStatement[][] = [];
	const allCalls: MockStatement[] = [];

	function d1Result(stmt: MockStatement) {
		const config = resultsBySql[stmt.sql] ?? {};
		if (config.error) throw config.error;
		return {
			success: true,
			results: config.rows ?? [],
			meta: { changes: config.changes ?? 0, last_row_id: config.lastRowId ?? 0 },
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
					allCalls.push(stmt);
					return d1Result(stmt);
				},
			};
			return stmt;
		},
		// D1 batches are atomic: a single bad statement rejects the whole call,
		// which the throw inside d1Result reproduces.
		async batch(statements: MockStatement[]) {
			operations.push(`batch:${statements.map((s) => s.sql).join("|")}`);
			batchCalls.push(statements);
			return statements.map((s) => d1Result(s));
		},
	};

	return { database, operations, batchCalls, allCalls };
}

function createDb(mock: ReturnType<typeof createMockD1>) {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mock implements the prepare/batch subset the dialect uses
	const database = mock.database as unknown as D1Database;
	return new Kysely<any>({ dialect: new CoalescingD1Dialect({ database }) });
}

describe("CoalescingD1Dialect", () => {
	it("coalesces SELECTs issued in the same turn into one batch in issue order", async () => {
		const rowsA = [{ id: 1 }];
		const rowsB = [{ id: 2 }, { id: 3 }];
		const mock = createMockD1({
			"SELECT * FROM a": { rows: rowsA },
			"select * from b where id = ?": { rows: rowsB },
		});
		const db = createDb(mock);

		const [r1, r2] = await Promise.all([
			db.executeQuery(CompiledQuery.raw("SELECT * FROM a")),
			db.executeQuery(CompiledQuery.raw("select * from b where id = ?", ["abc"])),
		]);

		expect(mock.batchCalls).toHaveLength(1);
		expect(mock.batchCalls[0]?.map((s) => s.sql)).toEqual([
			"SELECT * FROM a",
			"select * from b where id = ?",
		]);
		// Each caller gets its own rows, and bind params are preserved.
		expect(r1.rows).toEqual(rowsA);
		expect(r2.rows).toEqual(rowsB);
		expect(mock.batchCalls[0]?.[1]?.params).toEqual(["abc"]);
		// Nothing went through the single-statement path.
		expect(mock.allCalls).toHaveLength(0);
	});

	it("does not batch sequentially awaited SELECTs", async () => {
		const mock = createMockD1({
			"select 1": { rows: [{ one: 1 }] },
			"select 2": { rows: [{ two: 2 }] },
		});
		const db = createDb(mock);

		const r1 = await db.executeQuery(CompiledQuery.raw("select 1"));
		const r2 = await db.executeQuery(CompiledQuery.raw("select 2"));

		expect(mock.batchCalls).toHaveLength(0);
		expect(mock.allCalls.map((s) => s.sql)).toEqual(["select 1", "select 2"]);
		expect(r1.rows).toEqual([{ one: 1 }]);
		expect(r2.rows).toEqual([{ two: 2 }]);
		// Lone SELECTs flow through the buffer but report no affected rows.
		expect(r1.numAffectedRows).toBeUndefined();
	});

	it("executes writes and CTEs immediately while same-turn SELECTs still coalesce", async () => {
		const mock = createMockD1({ "insert into a (name) values (?)": { changes: 1, lastRowId: 7 } });
		const db = createDb(mock);

		await Promise.all([
			db.executeQuery(CompiledQuery.raw("select * from a")),
			db.executeQuery(CompiledQuery.raw("insert into a (name) values (?)", ["x"])),
			db.executeQuery(CompiledQuery.raw("update a set name = ?", ["y"])),
			db.executeQuery(CompiledQuery.raw("delete from a where id = ?", [1])),
			db.executeQuery(CompiledQuery.raw("select * from b")),
			// WITH is never coalesced: SQLite allows CTEs on writes.
			db.executeQuery(CompiledQuery.raw("with x as (select 1) delete from a")),
		]);

		// Non-SELECTs hit the direct path before the macrotask flush fires.
		expect(mock.operations).toEqual([
			"all:insert into a (name) values (?)",
			"all:update a set name = ?",
			"all:delete from a where id = ?",
			"all:with x as (select 1) delete from a",
			"batch:select * from a|select * from b",
		]);
	});

	it("falls back to individual execution when the batch rejects", async () => {
		const failure = new Error("no such column: nope");
		const mock = createMockD1({
			"select good1": { rows: [{ ok: 1 }] },
			"select nope": { error: failure },
			"select good2": { rows: [{ ok: 2 }] },
		});
		const db = createDb(mock);

		const [r1, r2, r3] = await Promise.allSettled([
			db.executeQuery(CompiledQuery.raw("select good1")),
			db.executeQuery(CompiledQuery.raw("select nope")),
			db.executeQuery(CompiledQuery.raw("select good2")),
		]);

		// One atomic batch was attempted, then every statement re-ran solo.
		expect(mock.batchCalls).toHaveLength(1);
		expect(mock.allCalls.map((s) => s.sql)).toEqual([
			"select good1",
			"select nope",
			"select good2",
		]);

		expect(r1.status).toBe("fulfilled");
		if (r1.status === "fulfilled") expect(r1.value.rows).toEqual([{ ok: 1 }]);
		expect(r2.status).toBe("rejected");
		if (r2.status === "rejected") expect(r2.reason).toBe(failure);
		expect(r3.status).toBe("fulfilled");
		if (r3.status === "fulfilled") expect(r3.value.rows).toEqual([{ ok: 2 }]);
	});

	it("maps rows, numAffectedRows and insertId on the direct path", async () => {
		const mock = createMockD1({
			"insert into a (name) values (?)": { changes: 2, lastRowId: 7 },
			"delete from a where 1 = 0": { changes: 0 },
		});
		const db = createDb(mock);

		const inserted = await db.executeQuery(
			CompiledQuery.raw("insert into a (name) values (?)", ["x"]),
		);
		expect(inserted.rows).toEqual([]);
		expect(inserted.numAffectedRows).toBe(2n);
		expect(inserted.insertId).toBe(7n);
		expect(mock.allCalls[0]?.params).toEqual(["x"]);

		// Zero changes maps to undefined, matching kysely-d1.
		const deleted = await db.executeQuery(CompiledQuery.raw("delete from a where 1 = 0"));
		expect(deleted.numAffectedRows).toBeUndefined();
		expect(mock.batchCalls).toHaveLength(0);
	});

	it("starts a new batch window after a flush", async () => {
		const mock = createMockD1();
		const db = createDb(mock);

		await Promise.all([
			db.executeQuery(CompiledQuery.raw("select 1")),
			db.executeQuery(CompiledQuery.raw("select 2")),
		]);
		await Promise.all([
			db.executeQuery(CompiledQuery.raw("select 3")),
			db.executeQuery(CompiledQuery.raw("select 4")),
		]);

		expect(mock.batchCalls).toHaveLength(2);
		expect(mock.batchCalls[0]?.map((s) => s.sql)).toEqual(["select 1", "select 2"]);
		expect(mock.batchCalls[1]?.map((s) => s.sql)).toEqual(["select 3", "select 4"]);
	});

	it("never overlaps physical session calls: a write and a SELECT batch run serially", async () => {
		// The driver flips supportsMultipleConnections to true, which removes
		// Kysely's connection mutex. A same-turn write (direct path) must still
		// not run concurrently with the buffered-SELECT batch on the shared D1
		// session — overlapping calls could interleave the session bookmark.
		// This mock counts how many physical calls are in flight at once; the
		// pre-serialization code reaches 2 here.
		let inFlight = 0;
		let maxInFlight = 0;
		const ops: string[] = [];
		const okResult = () => ({ success: true, results: [], meta: { changes: 0, last_row_id: 0 } });
		async function hold<T>(label: string, value: T): Promise<T> {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			ops.push(label);
			// Hold the "connection" across a macrotask so a concurrent call,
			// if one were issued, would be observed in flight simultaneously.
			await new Promise((resolve) => setTimeout(resolve, 0));
			inFlight--;
			return value;
		}
		function makeStatement(sql: string): MockStatement {
			const stmt: MockStatement = {
				sql,
				params: [],
				bind(...params: unknown[]) {
					stmt.params = params;
					return stmt;
				},
				all: () => hold(`all:${stmt.sql}`, okResult()),
			};
			return stmt;
		}
		const database = {
			prepare: (sql: string) => makeStatement(sql),
			batch: (statements: MockStatement[]) =>
				hold(
					`batch:${statements.map((s) => s.sql).join("|")}`,
					statements.map(() => okResult()),
				),
		};
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mock implements the prepare/batch subset the dialect uses
		const db = new Kysely<any>({
			dialect: new CoalescingD1Dialect({ database: database as unknown as D1Database }),
		});

		await Promise.all([
			db.executeQuery(CompiledQuery.raw("select * from a")),
			db.executeQuery(CompiledQuery.raw("select * from b")),
			db.executeQuery(CompiledQuery.raw("update a set n = ?", ["x"])),
		]);

		expect(maxInFlight).toBe(1);
		// The write executes first (direct path, enqueued immediately), then the
		// coalesced SELECT batch — never overlapping.
		expect(ops).toEqual(["all:update a set n = ?", "batch:select * from a|select * from b"]);
	});

	it("rejects transactions", async () => {
		const db = createDb(createMockD1());

		await expect(
			db.transaction().execute(async () => {
				// never reached
			}),
		).rejects.toThrow("Transactions are not supported");
	});
});
