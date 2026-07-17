/**
 * better-sqlite3-compatible wrapper around node:sqlite.
 *
 * Kysely's built-in SqliteDialect drives the database through better-sqlite3's
 * surface: `prepare()`, statement `.reader` / `.all(params)` / `.run(params)` /
 * `.iterate(params)`, and `close()`. node:sqlite's DatabaseSync supports the
 * same operations but binds parameters as spread arguments and has no
 * `.reader` flag. This wrapper bridges the two so the dialect needs no native
 * compiled dependency.
 *
 * `.reader` is derived from `StatementSync.columns()` (column count > 0),
 * which — like better-sqlite3's flag — is true for any statement that returns
 * rows, including `INSERT ... RETURNING`.
 *
 * Requires Node >= 22.15 (node:sqlite unflagged + StatementSync.columns()).
 */

import { DatabaseSync } from "node:sqlite";

/**
 * The subset of better-sqlite3's Database API that emdash consumes: what
 * Kysely's SqliteDialect calls, plus `exec`/`pragma` used at connection setup.
 */
export interface NodeSqliteCompatDatabase {
	close(): void;
	prepare(sql: string): NodeSqliteCompatStatement;
	exec(sql: string): void;
	pragma(pragma: string): void;
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

/**
 * Open a SQLite database via node:sqlite, exposed through the
 * better-sqlite3-compatible surface above. Pass the result directly to
 * Kysely's `new SqliteDialect({ database })`.
 */
export function openNodeSqliteDatabase(path: string): NodeSqliteCompatDatabase {
	const db = new DatabaseSync(path);

	return {
		close: () => db.close(),
		exec: (sql) => db.exec(sql),
		pragma: (pragma) => db.exec(`PRAGMA ${pragma}`),
		prepare(sql) {
			const stmt = db.prepare(sql);
			return {
				reader: stmt.columns().length > 0,
				all: (parameters) => stmt.all(...toBindings(parameters)),
				run: (parameters) => stmt.run(...toBindings(parameters)),
				iterate: (parameters) => stmt.iterate(...toBindings(parameters)),
			};
		},
	};
}

/** Parameter type accepted by node:sqlite statement bindings. */
type SQLInputValue = null | number | bigint | string | Uint8Array;

function toBindings(parameters: ReadonlyArray<unknown>): SQLInputValue[] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely hands through the values it compiled into the query; node:sqlite rejects any unsupported type at bind time, same as better-sqlite3 did
	return parameters as SQLInputValue[];
}
