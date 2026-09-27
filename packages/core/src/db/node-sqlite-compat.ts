import { DatabaseSync } from "node:sqlite";

export interface NodeSqliteCompatStatement {
	readonly reader: boolean;
	all(parameters: ReadonlyArray<unknown>): unknown[];
	all(...parameters: unknown[]): unknown[];
	get(parameters: ReadonlyArray<unknown>): unknown;
	get(...parameters: unknown[]): unknown;
	run(parameters: ReadonlyArray<unknown>): {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	};
	run(...parameters: unknown[]): {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	};
	iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
	iterate(...parameters: unknown[]): IterableIterator<unknown>;
}

export interface NodeSqliteOpenOptions {
	journalMode?: "wal";
	readOnly?: boolean;
}

type SqliteBinding = null | number | bigint | string | Uint8Array;

export function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteOpenOptions = {},
): NodeSqliteCompatDatabase {
	return new NodeSqliteCompatDatabase(path, options);
}

export class NodeSqliteCompatDatabase {
	readonly #database: DatabaseSync;

	constructor(path: string, options: NodeSqliteOpenOptions = {}) {
		const database = new DatabaseSync(path, { readOnly: options.readOnly });
		this.#database = database;

		try {
			database.exec("PRAGMA busy_timeout = 5000");
			database.exec("PRAGMA foreign_keys = ON");
			// Negative cache_size values are kibibytes.
			database.exec("PRAGMA cache_size = -16000");
			if (options.journalMode === "wal" && !options.readOnly) {
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
	}

	get open(): boolean {
		return this.#database.isOpen;
	}

	close(): void {
		if (this.#database.isOpen) this.#database.close();
	}

	exec(sql: string): void {
		this.#database.exec(sql);
	}

	prepare(sql: string): NodeSqliteCompatStatement {
		const statement = this.#database.prepare(sql);
		return {
			reader: statement.columns().length > 0,
			all: (...parameters) => statement.all(...toBindings(normalizeParameters(parameters))),
			get: (...parameters) => statement.get(...toBindings(normalizeParameters(parameters))),
			run: (...parameters) => statement.run(...toBindings(normalizeParameters(parameters))),
			iterate: (...parameters) => statement.iterate(...toBindings(normalizeParameters(parameters))),
		};
	}
}

function normalizeParameters(parameters: unknown[]): ReadonlyArray<unknown> {
	return parameters.length === 1 && Array.isArray(parameters[0]) ? parameters[0] : parameters;
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
