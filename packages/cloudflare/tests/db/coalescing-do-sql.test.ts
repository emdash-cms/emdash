import { CompiledQuery } from "kysely";
import { describe, it, expect, vi } from "vitest";

import { CoalescingDOSqlDialect } from "../../src/db/coalescing-do-sql.js";
import type { BookmarkSink } from "../../src/db/do-sql-dialect.js";
import type { DOQueryResult, EmDashDBStub } from "../../src/db/do-sql-types.js";

function setup(
	opts: {
		query?: ReturnType<typeof vi.fn>;
		batchQuery?: ReturnType<typeof vi.fn>;
		readBookmark?: string;
		bookmarkSink?: BookmarkSink;
	} = {},
) {
	const query = opts.query ?? vi.fn().mockResolvedValue({ rows: [] });
	const batchQuery = opts.batchQuery ?? vi.fn().mockResolvedValue([]);
	const stub = { query, batchQuery } as unknown as EmDashDBStub;
	const dialect = new CoalescingDOSqlDialect({
		resolveStub: () => stub,
		readBookmark: opts.readBookmark,
		bookmarkSink: opts.bookmarkSink,
	});
	return { query, batchQuery, dialect };
}

describe("CoalescingDOSqlDialect", () => {
	it("reports supportsMultipleConnections so Kysely won't serialize behind a mutex", () => {
		const { dialect } = setup();
		expect(dialect.createAdapter().supportsMultipleConnections).toBe(true);
	});

	it("rejects transactions (matches the non-coalescing driver)", async () => {
		const { dialect } = setup();
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();
		await expect(driver.beginTransaction(conn, {})).rejects.toThrow(
			/transactions are not supported/i,
		);
	});

	it("batches same-turn SELECTs into one batchQuery RPC", async () => {
		const batchQuery = vi
			.fn()
			.mockResolvedValue([{ rows: [{ id: "a" }] }, { rows: [{ id: "b" }] }] as DOQueryResult[]);
		const { query, dialect } = setup({ batchQuery });
		const conn = await dialect.createDriver().acquireConnection();

		const [r1, r2] = await Promise.all([
			conn.executeQuery(CompiledQuery.raw("SELECT * FROM a")),
			conn.executeQuery(CompiledQuery.raw("SELECT * FROM b")),
		]);

		expect(batchQuery).toHaveBeenCalledTimes(1);
		expect(batchQuery.mock.calls[0]![0]).toEqual([
			{ sql: "SELECT * FROM a", params: [] },
			{ sql: "SELECT * FROM b", params: [] },
		]);
		expect(r1.rows).toEqual([{ id: "a" }]);
		expect(r2.rows).toEqual([{ id: "b" }]);
		expect(query).not.toHaveBeenCalled();
	});

	it("runs a lone SELECT via query(), not batchQuery", async () => {
		const query = vi.fn().mockResolvedValue({ rows: [{ id: "x" }] });
		const { batchQuery, dialect } = setup({ query });
		const conn = await dialect.createDriver().acquireConnection();

		const result = await conn.executeQuery(CompiledQuery.raw("SELECT * FROM solo"));

		expect(query).toHaveBeenCalledTimes(1);
		expect(batchQuery).not.toHaveBeenCalled();
		expect(result.rows).toEqual([{ id: "x" }]);
	});

	it("sends writes down the direct query() path, never the batch", async () => {
		const query = vi.fn().mockResolvedValue({ rows: [], changes: 1, bookmark: "bm" });
		const { batchQuery, dialect } = setup({ query });
		const conn = await dialect.createDriver().acquireConnection();

		await conn.executeQuery(CompiledQuery.raw("INSERT INTO a (id) VALUES (?)", ["1"]));

		expect(query).toHaveBeenCalledWith("INSERT INTO a (id) VALUES (?)", ["1"], undefined);
		expect(batchQuery).not.toHaveBeenCalled();
	});

	it("forwards the effective bookmark with the batch", async () => {
		const batchQuery = vi.fn().mockResolvedValue([{ rows: [] }, { rows: [] }] as DOQueryResult[]);
		const sink: BookmarkSink = { latest: "bm-fresh" };
		const { dialect } = setup({ batchQuery, readBookmark: "bm-cookie", bookmarkSink: sink });
		const conn = await dialect.createDriver().acquireConnection();

		await Promise.all([
			conn.executeQuery(CompiledQuery.raw("SELECT 1")),
			conn.executeQuery(CompiledQuery.raw("SELECT 2")),
		]);

		// Sink (freshest write bookmark) wins over the initial cookie bookmark.
		expect(batchQuery).toHaveBeenCalledWith(expect.any(Array), { bookmark: "bm-fresh" });
	});

	it("falls back to individual query() calls when the batch RPC fails", async () => {
		const batchQuery = vi.fn().mockRejectedValue(new Error("batch boom"));
		const query = vi
			.fn()
			.mockResolvedValueOnce({ rows: [{ id: "a" }] })
			.mockResolvedValueOnce({ rows: [{ id: "b" }] });
		const { dialect } = setup({ query, batchQuery });
		const conn = await dialect.createDriver().acquireConnection();

		const [r1, r2] = await Promise.all([
			conn.executeQuery(CompiledQuery.raw("SELECT * FROM a")),
			conn.executeQuery(CompiledQuery.raw("SELECT * FROM b")),
		]);

		expect(batchQuery).toHaveBeenCalledTimes(1);
		expect(query).toHaveBeenCalledTimes(2);
		expect(r1.rows).toEqual([{ id: "a" }]);
		expect(r2.rows).toEqual([{ id: "b" }]);
	});

	it("rejects only the missing statement if the batch returns too few results", async () => {
		const batchQuery = vi.fn().mockResolvedValue([{ rows: [{ id: "a" }] }] as DOQueryResult[]);
		const { dialect } = setup({ batchQuery });
		const conn = await dialect.createDriver().acquireConnection();

		const results = await Promise.allSettled([
			conn.executeQuery(CompiledQuery.raw("SELECT * FROM a")),
			conn.executeQuery(CompiledQuery.raw("SELECT * FROM b")),
		]);

		expect(results[0]).toMatchObject({ status: "fulfilled" });
		expect(results[1]).toMatchObject({ status: "rejected" });
	});
});
