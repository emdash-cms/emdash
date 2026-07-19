import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { detectDialect } from "../../../src/database/dialect-helpers.js";

/**
 * Regression tests for dialect misdetection under minification.
 *
 * The consuming app can bundle + minify emdash (e.g. an Astro SSR build), which
 * mangles the `PostgresAdapter` class name. Relying only on `constructor.name`
 * then misdetects Postgres as SQLite and emits SQLite-only SQL like
 * `datetime('now')`, failing the first migration on Postgres.
 *
 * The first two cases exercise the *real* Kysely adapters so the fallback signal
 * (`supportsMultipleConnections`) is validated against actual runtime behavior,
 * not a hand-rolled stub.
 */
describe("detectDialect", () => {
	let dbs: Array<Kysely<Record<string, never>>> = [];

	afterEach(async () => {
		await Promise.all(dbs.map((db) => db.destroy()));
		dbs = [];
	});

	it("detects a real Kysely Postgres adapter", () => {
		// createAdapter() is synchronous and makes no connection.
		const db = new Kysely<Record<string, never>>({
			dialect: new PostgresDialect({ pool: {} as never }),
		});
		dbs.push(db);
		expect(detectDialect(db)).toBe("postgres");
	});

	it("detects a real Kysely SQLite adapter", () => {
		const db = new Kysely<Record<string, never>>({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
		});
		dbs.push(db);
		expect(detectDialect(db)).toBe("sqlite");
	});

	it("still detects Postgres when the adapter class name is minified", () => {
		// A bundled/minified build renames `PostgresAdapter`, so only the
		// behavioral capability survives to distinguish the dialect.
		const adapter = { supportsMultipleConnections: true };
		const db = {
			getExecutor: () => ({ adapter }),
		} as unknown as Kysely<Record<string, never>>;
		expect(detectDialect(db)).toBe("postgres");
	});
});
