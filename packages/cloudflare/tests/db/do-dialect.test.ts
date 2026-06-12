import { CompiledQuery } from "kysely";
import { describe, it, expect, vi } from "vitest";

import { PreviewDODialect } from "../../src/db/do-dialect.js";
import type { PreviewDODialectConfig } from "../../src/db/do-dialect.js";

function createMockStub(queryFn = vi.fn()) {
	return { query: queryFn };
}

function createConfig(queryFn = vi.fn()): PreviewDODialectConfig {
	const stub = createMockStub(queryFn);
	return { getStub: () => stub };
}

describe("PreviewDODialect", () => {
	it("creates a SqliteAdapter", () => {
		const dialect = new PreviewDODialect(createConfig());
		const adapter = dialect.createAdapter();
		expect(adapter.constructor.name).toBe("SqliteAdapter");
	});

	it("creates a SqliteQueryCompiler", () => {
		const dialect = new PreviewDODialect(createConfig());
		const compiler = dialect.createQueryCompiler();
		expect(compiler.constructor.name).toBe("SqliteQueryCompiler");
	});
});

describe("PreviewDODriver", () => {
	it("acquires a connection", async () => {
		const dialect = new PreviewDODialect(createConfig());
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		expect(conn.executeQuery).toBeTypeOf("function");
	});

	it("transaction methods are no-ops (preview is read-only)", async () => {
		const queryFn = vi.fn();
		const dialect = new PreviewDODialect(createConfig(queryFn));
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();

		await driver.beginTransaction(conn, {});
		await driver.commitTransaction(conn);
		await driver.rollbackTransaction(conn);

		// Preview is read-only: transaction control must not issue any SQL to the stub.
		expect(queryFn).not.toHaveBeenCalled();
	});
});

describe("PreviewDOConnection", () => {
	it("passes sql and parameters to the stub", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [], changes: 0 });
		const dialect = new PreviewDODialect(createConfig(queryFn));
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();

		await conn.executeQuery(CompiledQuery.raw("SELECT * FROM users WHERE id = ?", ["abc"]));

		expect(queryFn).toHaveBeenCalledWith("SELECT * FROM users WHERE id = ?", ["abc"]);
	});

	it("returns rows from the stub result", async () => {
		const rows = [
			{ id: "1", name: "Alice" },
			{ id: "2", name: "Bob" },
		];
		const queryFn = vi.fn().mockResolvedValue({ rows, changes: 0 });
		const dialect = new PreviewDODialect(createConfig(queryFn));
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();

		const result = await conn.executeQuery(CompiledQuery.raw("SELECT * FROM users"));

		expect(result.rows).toEqual(rows);
	});

	it("converts changes to bigint numAffectedRows", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [], changes: 3 });
		const dialect = new PreviewDODialect(createConfig(queryFn));
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();

		const result = await conn.executeQuery(CompiledQuery.raw("UPDATE users SET name = ?", ["x"]));

		expect(result.numAffectedRows).toBe(3n);
	});

	it("sets numAffectedRows to undefined when changes is undefined", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: 5 }] });
		const dialect = new PreviewDODialect(createConfig(queryFn));
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();

		const result = await conn.executeQuery(
			CompiledQuery.raw("SELECT count(*) as count FROM users"),
		);

		expect(result.numAffectedRows).toBeUndefined();
	});

	it("handles zero changes correctly", async () => {
		const queryFn = vi.fn().mockResolvedValue({ rows: [], changes: 0 });
		const dialect = new PreviewDODialect(createConfig(queryFn));
		const driver = dialect.createDriver();
		const conn = await driver.acquireConnection();

		const result = await conn.executeQuery(CompiledQuery.raw("DELETE FROM users WHERE 1=0"));

		expect(result.numAffectedRows).toBe(0n);
	});
});
