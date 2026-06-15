import { CompiledQuery } from "kysely";
import { describe, it, expect, vi } from "vitest";

import { DOSqlDialect } from "../../src/db/do-sql-dialect.js";
import type { BookmarkSink, DOSqlDialectConfig } from "../../src/db/do-sql-dialect.js";
import type { EmDashDBStub } from "../../src/db/do-sql-types.js";

function createMockStub(queryFn = vi.fn()): EmDashDBStub {
	return { query: queryFn };
}

function createConfig(
	queryFn = vi.fn(),
	extra: Partial<DOSqlDialectConfig> = {},
): { config: DOSqlDialectConfig; resolveStub: ReturnType<typeof vi.fn> } {
	const stub = createMockStub(queryFn);
	const resolveStub = vi.fn(() => stub);
	return { config: { resolveStub, ...extra }, resolveStub };
}

describe("DOSqlDialect", () => {
	it("creates a SqliteAdapter and SqliteQueryCompiler", () => {
		const { config } = createConfig();
		const dialect = new DOSqlDialect(config);
		expect(dialect.createAdapter().constructor.name).toBe("SqliteAdapter");
		expect(dialect.createQueryCompiler().constructor.name).toBe("SqliteQueryCompiler");
	});
});

describe("DOSqlDriver", () => {
	it("rejects transactions (matches D1, so withTransaction degrades)", async () => {
		const { config } = createConfig();
		const driver = new DOSqlDialect(config).createDriver();
		const conn = await driver.acquireConnection();
		await expect(driver.beginTransaction(conn, {})).rejects.toThrow(
			/transactions are not supported/i,
		);
	});

	it("resolves a stub per acquire (driver must not cache a per-request stub)", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [] });
		const { config, resolveStub } = createConfig(queryFn);
		const driver = new DOSqlDialect(config).createDriver();

		await driver.acquireConnection();
		await driver.acquireConnection();

		// The driver never caches: a DO stub is a per-request I/O object, so the
		// cross-request-cached singleton dialect would otherwise reuse a stale stub.
		expect(resolveStub).toHaveBeenCalledTimes(2);
	});

	it("a memoizing resolveStub (the request-scoped pattern) yields one stub per request", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [] });
		const stub: EmDashDBStub = { query: queryFn };
		const make = vi.fn(() => stub);
		// Mirrors createRequestScopedDb: a per-request closure memoizes the stub.
		let cached: EmDashDBStub | undefined;
		const resolveStub = () => (cached ??= make());
		const driver = new DOSqlDialect({ resolveStub }).createDriver();

		const c1 = await driver.acquireConnection();
		await c1.executeQuery(CompiledQuery.raw("SELECT 1"));
		const c2 = await driver.acquireConnection();
		await c2.executeQuery(CompiledQuery.raw("SELECT 2"));

		expect(make).toHaveBeenCalledTimes(1);
	});
});

describe("DOSqlConnection", () => {
	it("passes sql and parameters to the stub", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [], changes: 0 });
		const { config } = createConfig(queryFn);
		const conn = await new DOSqlDialect(config).createDriver().acquireConnection();

		await conn.executeQuery(CompiledQuery.raw("SELECT * FROM users WHERE id = ?", ["abc"]));

		expect(queryFn).toHaveBeenCalledWith("SELECT * FROM users WHERE id = ?", ["abc"], undefined);
	});

	it("converts changes to bigint numAffectedRows", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [], changes: 3 });
		const { config } = createConfig(queryFn);
		const conn = await new DOSqlDialect(config).createDriver().acquireConnection();

		const result = await conn.executeQuery(CompiledQuery.raw("UPDATE users SET name = ?", ["x"]));

		expect(result.numAffectedRows).toBe(3n);
	});

	it("leaves numAffectedRows undefined for reads", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: 5 }] });
		const { config } = createConfig(queryFn);
		const conn = await new DOSqlDialect(config).createDriver().acquireConnection();

		const result = await conn.executeQuery(CompiledQuery.raw("SELECT count(*) as count FROM x"));

		expect(result.numAffectedRows).toBeUndefined();
		expect(result.rows).toEqual([{ count: 5 }]);
	});

	it("forwards the read-your-writes bookmark only on reads", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [] });
		const { config } = createConfig(queryFn, { readBookmark: "bm-123" });
		const conn = await new DOSqlDialect(config).createDriver().acquireConnection();

		await conn.executeQuery(CompiledQuery.raw("SELECT * FROM posts"));
		expect(queryFn).toHaveBeenLastCalledWith("SELECT * FROM posts", [], { bookmark: "bm-123" });

		await conn.executeQuery(CompiledQuery.raw("INSERT INTO posts (id) VALUES (?)", ["1"]));
		// Writes never carry the read bookmark.
		expect(queryFn).toHaveBeenLastCalledWith("INSERT INTO posts (id) VALUES (?)", ["1"], undefined);
	});

	it("records the latest write bookmark into the sink", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [], changes: 1, bookmark: "bm-new" });
		const sink: BookmarkSink = {};
		const { config } = createConfig(queryFn, { bookmarkSink: sink });
		const conn = await new DOSqlDialect(config).createDriver().acquireConnection();

		await conn.executeQuery(CompiledQuery.raw("INSERT INTO posts (id) VALUES (?)", ["1"]));

		expect(sink.latest).toBe("bm-new");
	});

	it("read-after-write: a read uses the fresh write bookmark, not the stale cookie one", async () => {
		// Simulates create() then findById() in one request: the write mints a
		// new bookmark; the follow-up read must wait for THAT, not the request's
		// initial cookie bookmark, or it would miss the row on a lagging replica.
		const queryFn = vi
			.fn()
			.mockResolvedValueOnce({ rows: [], changes: 1, bookmark: "bm-after-write" })
			.mockResolvedValueOnce({ rows: [{ id: "1" }] });
		const sink: BookmarkSink = {};
		const { config } = createConfig(queryFn, {
			readBookmark: "bm-stale-cookie",
			bookmarkSink: sink,
		});
		const conn = await new DOSqlDialect(config).createDriver().acquireConnection();

		await conn.executeQuery(CompiledQuery.raw("INSERT INTO posts (id) VALUES (?)", ["1"]));
		await conn.executeQuery(CompiledQuery.raw("SELECT * FROM posts WHERE id = ?", ["1"]));

		expect(queryFn).toHaveBeenLastCalledWith("SELECT * FROM posts WHERE id = ?", ["1"], {
			bookmark: "bm-after-write",
		});
	});

	it("falls back to the initial cookie bookmark for reads before any write", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [] });
		const sink: BookmarkSink = {};
		const { config } = createConfig(queryFn, { readBookmark: "bm-cookie", bookmarkSink: sink });
		const conn = await new DOSqlDialect(config).createDriver().acquireConnection();

		await conn.executeQuery(CompiledQuery.raw("SELECT * FROM posts"));

		expect(queryFn).toHaveBeenLastCalledWith("SELECT * FROM posts", [], { bookmark: "bm-cookie" });
	});
});
