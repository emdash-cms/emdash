import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";

describe("openNodeSqliteDatabase", () => {
	const openDatabases: ReturnType<typeof openNodeSqliteDatabase>[] = [];
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		for (const database of openDatabases.splice(0)) database.close();
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	function open(path = ":memory:", options?: { journalMode?: "wal" }) {
		const database = openNodeSqliteDatabase(path, options);
		openDatabases.push(database);
		return database;
	}

	function temporaryDatabasePath(): string {
		const directory = mkdtempSync(join(tmpdir(), "emdash-node-sqlite-"));
		temporaryDirectories.push(directory);
		return join(directory, "data.db");
	}

	it("implements the statement contract Kysely uses", async () => {
		const database = open();
		const db = new Kysely<{ entries: { id: number | null; title: string } }>({
			dialect: new SqliteDialect({ database }),
		});

		await db.schema
			.createTable("entries")
			.addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
			.addColumn("title", "text", (column) => column.notNull())
			.execute();

		const inserted = await db
			.insertInto("entries")
			.values({ title: "First entry" })
			.returning("id")
			.executeTakeFirstOrThrow();
		expect(inserted.id).toBe(1);
		expect(await db.selectFrom("entries").selectAll().execute()).toEqual([
			{ id: 1, title: "First entry" },
		]);

		openDatabases.pop();
		await db.destroy();
	});

	it("normalizes supported positional values without shifting parameters", () => {
		const database = open();
		database.prepare("CREATE TABLE values_test (a, b, c, d, e, f)").run([]);
		database
			.prepare("INSERT INTO values_test VALUES (?, ?, ?, ?, ?, ?)")
			.run([undefined, true, false, 7n, "text", new Uint8Array([1, 2])]);

		const row = database.prepare("SELECT * FROM values_test").all([])[0];
		expect(row).toEqual({
			a: null,
			b: 1,
			c: 0,
			d: 7,
			e: "text",
			f: new Uint8Array([1, 2]),
		});
	});

	it.each([
		["plain object", {}],
		["array", []],
		["date", new Date("2026-01-01T00:00:00.000Z")],
		["boxed number", new Number(1)],
	])("rejects an unsupported %s before executing the statement", (_name, value) => {
		const database = open();
		database.prepare("CREATE TABLE rejected_values (first, second)").run([]);
		const insert = database.prepare("INSERT INTO rejected_values VALUES (?, ?)");

		expect(() => insert.run([value, "must-not-shift"])).toThrow(/Cannot bind/);
		expect(database.prepare("SELECT COUNT(*) AS count FROM rejected_values").all([])).toEqual([
			{ count: 0 },
		]);
	});

	it("matches the existing SQLite runtime connection defaults", () => {
		const database = open(temporaryDatabasePath());

		expect(database.prepare("PRAGMA journal_mode").all([])).toEqual([{ journal_mode: "delete" }]);
		expect(database.prepare("PRAGMA synchronous").all([])).toEqual([{ synchronous: 2 }]);
		expect(database.prepare("PRAGMA cache_size").all([])).toEqual([{ cache_size: -16000 }]);
		expect(database.prepare("PRAGMA busy_timeout").all([])).toEqual([{ timeout: 5000 }]);
		expect(database.prepare("PRAGMA foreign_keys").all([])).toEqual([{ foreign_keys: 1 }]);
	});

	it("matches the existing CLI WAL settings", () => {
		const database = open(temporaryDatabasePath(), { journalMode: "wal" });

		expect(database.prepare("PRAGMA journal_mode").all([])).toEqual([{ journal_mode: "wal" }]);
		expect(database.prepare("PRAGMA synchronous").all([])).toEqual([{ synchronous: 1 }]);
		expect(database.prepare("PRAGMA cache_size").all([])).toEqual([{ cache_size: -16000 }]);
	});

	it("keeps NORMAL synchronization when runtime reopens an existing WAL database", () => {
		const path = temporaryDatabasePath();
		const cliDatabase = open(path, { journalMode: "wal" });
		cliDatabase.close();
		openDatabases.pop();

		const runtimeDatabase = open(path);
		expect(runtimeDatabase.prepare("PRAGMA journal_mode").all([])).toEqual([
			{ journal_mode: "wal" },
		]);
		expect(runtimeDatabase.prepare("PRAGMA synchronous").all([])).toEqual([{ synchronous: 1 }]);
	});
});
