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
