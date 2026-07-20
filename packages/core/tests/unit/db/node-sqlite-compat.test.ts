import { Kysely, SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";

describe("openNodeSqliteDatabase", () => {
	it("exposes exec and pragma", () => {
		const db = openNodeSqliteDatabase(":memory:");
		db.pragma("foreign_keys = ON");
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
		const stmt = db.prepare("SELECT name FROM t");
		expect(stmt.all([])).toEqual([]);
		db.close();
	});

	it("marks row-returning statements as reader, including RETURNING", () => {
		const db = openNodeSqliteDatabase(":memory:");
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

		expect(db.prepare("SELECT * FROM t").reader).toBe(true);
		expect(db.prepare("INSERT INTO t (name) VALUES (?)").reader).toBe(false);
		expect(db.prepare("INSERT INTO t (name) VALUES (?) RETURNING id").reader).toBe(true);
		expect(db.prepare("UPDATE t SET name = ?").reader).toBe(false);
		db.close();
	});

	it("binds array parameters for all/run and reports changes and lastInsertRowid", () => {
		const db = openNodeSqliteDatabase(":memory:");
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

		const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
		const first = insert.run(["alpha"]);
		expect(Number(first.changes)).toBe(1);
		expect(Number(first.lastInsertRowid)).toBe(1);

		insert.run(["beta"]);
		const rows = db.prepare("SELECT name FROM t WHERE name = ?").all(["beta"]);
		expect(rows).toEqual([expect.objectContaining({ name: "beta" })]);
		db.close();
	});

	it("applies connection pragmas on open", () => {
		const db = openNodeSqliteDatabase(":memory:");
		// foreign_keys is off by default in SQLite; the wrapper turns it on so
		// every entry point (CLI + runtime adapter) enforces the schema's FKs.
		expect(db.prepare("PRAGMA foreign_keys").all([])).toEqual([
			expect.objectContaining({ foreign_keys: 1 }),
		]);
		expect(db.prepare("PRAGMA busy_timeout").all([])).toEqual([
			expect.objectContaining({ timeout: 5000 }),
		]);
		db.close();
	});

	// node:sqlite binds a narrower set of JS types than better-sqlite3 did, and
	// differs in both directions. toBindings normalizes the gaps; these lock in
	// that contract.
	describe("parameter binding compatibility", () => {
		it("maps booleans to 0/1 instead of throwing", () => {
			const db = openNodeSqliteDatabase(":memory:");
			db.exec("CREATE TABLE t (v)");
			db.prepare("INSERT INTO t (v) VALUES (?)").run([true]);
			db.prepare("INSERT INTO t (v) VALUES (?)").run([false]);
			expect(db.prepare("SELECT v FROM t ORDER BY rowid").all([])).toEqual([
				expect.objectContaining({ v: 1 }),
				expect.objectContaining({ v: 0 }),
			]);
			db.close();
		});

		it("binds undefined as NULL, matching better-sqlite3", () => {
			const db = openNodeSqliteDatabase(":memory:");
			db.exec("CREATE TABLE t (v)");
			db.prepare("INSERT INTO t (v) VALUES (?)").run([undefined]);
			expect(db.prepare("SELECT v FROM t").all([])).toEqual([
				expect.objectContaining({ v: null }),
			]);
			db.close();
		});

		it("rejects Date rather than silently storing NULL", () => {
			const db = openNodeSqliteDatabase(":memory:");
			db.exec("CREATE TABLE t (v)");
			expect(() => db.prepare("INSERT INTO t (v) VALUES (?)").run([new Date()])).toThrow(
				/Cannot bind a Date/,
			);
			db.close();
		});

		it("passes through the types both drivers accept", () => {
			const db = openNodeSqliteDatabase(":memory:");
			db.exec("CREATE TABLE t (v)");
			const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
			insert.run([null]);
			insert.run([42]);
			insert.run(["text"]);
			insert.run([7n]);
			insert.run([new Uint8Array([1, 2])]);
			const rows = db.prepare("SELECT v FROM t ORDER BY rowid").all([]);
			expect(rows).toHaveLength(5);
			db.close();
		});
	});

	it("works end-to-end through Kysely's SqliteDialect", async () => {
		const db = new Kysely<{ t: { id: number | null; name: string } }>({
			dialect: new SqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
		});

		await db.schema
			.createTable("t")
			.addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
			.addColumn("name", "text")
			.execute();

		const inserted = await db
			.insertInto("t")
			.values({ name: "alpha" })
			.returning("id")
			.executeTakeFirstOrThrow();
		expect(inserted.id).toBe(1);

		const row = await db
			.selectFrom("t")
			.select(["id", "name"])
			.where("name", "=", "alpha")
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ id: 1, name: "alpha" });

		const updated = await db
			.updateTable("t")
			.set({ name: "beta" })
			.where("id", "=", 1)
			.executeTakeFirst();
		expect(Number(updated.numUpdatedRows)).toBe(1);

		await db.destroy();
	});
});
