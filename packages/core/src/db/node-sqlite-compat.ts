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

	// Connection defaults, applied here because this is now the single place the
	// package opens a SQLite database — previously only the CLI path
	// (database/connection.ts) set them, so sites running through the runtime
	// adapter (db/sqlite.ts) silently got neither.
	//
	// WAL: readers don't block on the writer, and writes land in a log before
	// being applied — this is what prevents FTS5 shadow-table corruption if the
	// process is killed mid-write. No-op for `:memory:`.
	db.exec("PRAGMA journal_mode = WAL");
	// Wait for a competing writer instead of failing the query outright; without
	// it a concurrent write (backup, second process) surfaces as SQLITE_BUSY.
	db.exec("PRAGMA busy_timeout = 5000");
	// Referential integrity is off by default in SQLite; the schema declares
	// foreign keys, so enforce them.
	db.exec("PRAGMA foreign_keys = ON");

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

/**
 * Normalize Kysely's compiled parameters to what node:sqlite accepts.
 *
 * node:sqlite binds a narrower set of JS types than better-sqlite3 did, and
 * differs in both directions, so the values are mapped rather than cast:
 *
 * - `boolean` — rejected by BOTH drivers (better-sqlite3: "SQLite3 can only
 *   bind numbers, strings, bigints, buffers, and null"). SQLite has no boolean
 *   type and stores them as 0/1, and `json_extract` yields 0/1 for JSON
 *   booleans, so mapping here makes boolean filters work rather than throw —
 *   e.g. the plugin storage query API, whose `WhereValue` advertises `boolean`
 *   (see plugins/types.ts) but which threw at bind time on either driver.
 * - `undefined` — better-sqlite3 bound it as NULL; node:sqlite throws. Kysely
 *   passes it straight through (e.g. `.where(col, "=", undefined)` from an
 *   unset optional filter), so mapping to null preserves the old behaviour
 *   instead of turning a previously-working query into a runtime TypeError.
 * - `Date` — better-sqlite3 threw; node:sqlite silently binds NULL, which
 *   would turn a loud programming error into silent data loss. Rethrow with
 *   an actionable message: emdash stores timestamps as ISO strings.
 *
 * Everything else (number, bigint, string, Uint8Array/Buffer, null) binds
 * identically on both drivers and is passed through untouched; any remaining
 * unsupported type is still rejected by node:sqlite at bind time.
 */
function toBindings(parameters: ReadonlyArray<unknown>): SQLInputValue[] {
	return parameters.map((value) => {
		if (typeof value === "boolean") return value ? 1 : 0;
		if (value === undefined) return null;
		if (value instanceof Date) {
			throw new TypeError(
				"Cannot bind a Date to a SQLite parameter; convert it to an ISO string first (e.g. date.toISOString()).",
			);
		}
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely hands through the values it compiled into the query; node:sqlite rejects any remaining unsupported type at bind time, same as better-sqlite3 did
		return value as SQLInputValue;
	});
}
