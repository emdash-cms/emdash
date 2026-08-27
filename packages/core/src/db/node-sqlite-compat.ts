import { DatabaseSync } from "node:sqlite";

export interface NodeSqliteCompatDatabase {
	close(): void;
	prepare(sql: string): NodeSqliteCompatStatement;
}

export interface NodeSqliteCompatStatement {
	readonly reader: boolean;
	all(parameters: ReadonlyArray<unknown>): unknown[];
	run(parameters: ReadonlyArray<unknown>): {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	};
	iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

export interface NodeSqliteOpenOptions {
	journalMode?: "wal";
}

type SqliteBinding = null | number | bigint | string | Uint8Array;

export function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteOpenOptions = {},
): NodeSqliteCompatDatabase {
	const database = new DatabaseSync(path);

	try {
		database.exec("PRAGMA busy_timeout = 5000");
		database.exec("PRAGMA foreign_keys = ON");
		// Negative cache_size values are kibibytes.
		database.exec("PRAGMA cache_size = -16000");
		if (options.journalMode === "wal") {
			database.exec("PRAGMA journal_mode = WAL");
		}
		const journalMode = database.prepare("PRAGMA journal_mode").get()?.["journal_mode"];
		if (journalMode === "wal") {
			database.exec("PRAGMA synchronous = NORMAL");
		}
	} catch (error) {
		try {
			database.close();
		} catch {
			throw new Error("SQLite setup failed and the connection could not be closed", {
				cause: error,
			});
		}
		throw error;
	}

	return {
		close: () => database.close(),
		prepare(sql) {
			const statement = database.prepare(sql);
			return {
				reader: statement.columns().length > 0,
				all: (parameters) => statement.all(...toBindings(parameters)),
				run: (parameters) => statement.run(...toBindings(parameters)),
				iterate: (parameters) => statement.iterate(...toBindings(parameters)),
			};
		},
	};
}

function toBindings(parameters: ReadonlyArray<unknown>): SqliteBinding[] {
	return parameters.map((value) => {
		if (value === null || typeof value === "string" || typeof value === "number") {
			return value;
		}
		if (typeof value === "bigint") return value;
		if (typeof value === "boolean") return value ? 1 : 0;
		if (value === undefined) return null;
		if (value instanceof Uint8Array) return value;
		throw new TypeError(`Cannot bind ${Object.prototype.toString.call(value)} to SQLite`);
	});
}
