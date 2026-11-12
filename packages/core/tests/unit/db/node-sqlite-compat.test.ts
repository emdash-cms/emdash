import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
	NodeSqliteCompatDatabase,
	openNodeSqliteDatabase,
} from "../../../src/db/node-sqlite-compat.js";

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

	it("supports direct statement calls", () => {
		const database = new NodeSqliteCompatDatabase(":memory:");
		openDatabases.push(database);
		database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
		const insert = database.prepare("INSERT INTO entries (title) VALUES (?)");
		insert.run("First");
		insert.run("Second");

		expect(database.open).toBe(true);
		expect(database.prepare("SELECT title FROM entries ORDER BY id").all()).toEqual([
			{ title: "First" },
			{ title: "Second" },
		]);
		expect(database.prepare("SELECT title FROM entries WHERE id = ?").get(2)).toEqual({
			title: "Second",
		});
	});

	it("can be closed more than once", () => {
		const database = open();
		database.close();

		expect(() => database.close()).not.toThrow();
		expect(database.open).toBe(false);
		openDatabases.pop();
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

	it.each(["-wal", "-shm"])("refuses to create a database with an orphaned %s file", (suffix) => {
		const path = temporaryDatabasePath();
		const journal = Buffer.from("existing SQLite sidecar");
		writeFileSync(`${path}${suffix}`, journal);

		expect(() => open(path, { journalMode: "wal" })).toThrow(/Refusing to create SQLite database/);
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(`${path}${suffix}`)).toEqual(journal);

		rmSync(`${path}${suffix}`);
		const reset = open(path, { journalMode: "wal" });
		reset.exec("CREATE TABLE posts (title TEXT)");
		expect(reset.prepare("SELECT title FROM posts").all()).toEqual([]);
	});

	it("preserves WAL content when the main database is renamed away and restored", () => {
		const path = temporaryDatabasePath();
		// Exiting without closing leaves committed content in the WAL, as a stopped dev server can.
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { DatabaseSync } from "node:sqlite";
				const db = new DatabaseSync(process.argv[1]);
				db.exec("PRAGMA journal_mode = WAL; CREATE TABLE posts (title TEXT); INSERT INTO posts VALUES ('Original post');");
				process.exit(0);`,
				path,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const wal = readFileSync(`${path}-wal`);
		const shm = readFileSync(`${path}-shm`);
		renameSync(path, `${path}.renamed`);

		expect(() => open(path, { journalMode: "wal" })).toThrow(/Refusing to create SQLite database/);
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(`${path}-wal`)).toEqual(wal);
		expect(readFileSync(`${path}-shm`)).toEqual(shm);

		renameSync(`${path}.renamed`, path);
		const restored = open(path, { journalMode: "wal" });
		expect(restored.prepare("SELECT title FROM posts").all()).toEqual([{ title: "Original post" }]);
	});

	it("applies connection defaults without changing the journal mode", () => {
		const database = open(temporaryDatabasePath());

		expect(database.prepare("PRAGMA journal_mode").all([])).toEqual([{ journal_mode: "delete" }]);
		expect(database.prepare("PRAGMA synchronous").all([])).toEqual([{ synchronous: 2 }]);
		expect(database.prepare("PRAGMA cache_size").all([])).toEqual([{ cache_size: -16000 }]);
		expect(database.prepare("PRAGMA busy_timeout").all([])).toEqual([{ timeout: 5000 }]);
		expect(database.prepare("PRAGMA foreign_keys").all([])).toEqual([{ foreign_keys: 1 }]);
	});

	it("switches to WAL with NORMAL synchronization when requested", () => {
		const database = open(temporaryDatabasePath(), { journalMode: "wal" });

		expect(database.prepare("PRAGMA journal_mode").all([])).toEqual([{ journal_mode: "wal" }]);
		expect(database.prepare("PRAGMA synchronous").all([])).toEqual([{ synchronous: 1 }]);
		expect(database.prepare("PRAGMA cache_size").all([])).toEqual([{ cache_size: -16000 }]);
	});

	it("keeps NORMAL synchronization when reopening an existing WAL database without the option", () => {
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
