import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { up } from "../../../../src/database/migrations/081_redirect_write_guards.js";

describe("081_redirect_write_guards migration", () => {
	let db: Kysely<unknown> | undefined;

	afterEach(async () => {
		await db?.destroy();
	});

	it("preserves duplicate rows, guards one source, and can restart", async () => {
		const sqlite = new BetterSqlite3(":memory:");
		sqlite.exec(
			"CREATE TABLE _emdash_redirects (" +
				"id TEXT PRIMARY KEY, source TEXT NOT NULL, destination TEXT NOT NULL DEFAULT '', " +
				"type INTEGER NOT NULL DEFAULT 301, is_pattern INTEGER NOT NULL DEFAULT 0, " +
				"enabled INTEGER NOT NULL DEFAULT 1, group_name TEXT);" +
				"INSERT INTO _emdash_redirects (id, source) VALUES ('a', '/old'), ('b', '/old')",
		);
		db = new Kysely<unknown>({ dialect: new SqliteDialect({ database: sqlite }) });

		await up(db);
		await up(db);

		const rows = await sql<{
			config_revision: string;
			source_guard: number;
			write_generation: number;
		}>`
			SELECT config_revision, source_guard, write_generation
			FROM _emdash_redirects ORDER BY id
		`.execute(db);
		expect(rows.rows).toEqual([
			{ config_revision: "0", source_guard: 1, write_generation: 0 },
			{ config_revision: "0", source_guard: 0, write_generation: 0 },
		]);
		await sql`INSERT INTO _emdash_redirects (id, source) VALUES ('fresh', '/fresh')`.execute(db);
		const fresh = await sql<{ source_guard: number }>`
			SELECT source_guard FROM _emdash_redirects WHERE id = 'fresh'
		`.execute(db);
		expect(fresh.rows).toEqual([{ source_guard: 1 }]);
		await expect(
			sql`INSERT INTO _emdash_redirects (id, source) VALUES ('legacy', '/old')`.execute(db),
		).rejects.toThrow();
		await expect(
			sql`INSERT INTO _emdash_redirects (id, source, config_revision, source_guard)
				VALUES ('c', '/old', 'new', 1)`.execute(db),
		).rejects.toThrow();
		const lock = await sql<{
			id: number;
			token: string;
			expires_at: number;
			generation: number;
		}>`
			SELECT id, token, expires_at, generation FROM _emdash_redirect_write_lock
		`.execute(db);
		expect(lock.rows).toEqual([{ id: 1, token: "", expires_at: 0, generation: 0 }]);
	});

	it("allows previous-runtime writes when an enabled pattern redirect exists", async () => {
		const sqlite = new BetterSqlite3(":memory:");
		sqlite.exec(
			"CREATE TABLE _emdash_redirects (" +
				"id TEXT PRIMARY KEY, source TEXT NOT NULL, destination TEXT NOT NULL DEFAULT '', " +
				"type INTEGER NOT NULL DEFAULT 301, is_pattern INTEGER NOT NULL DEFAULT 0, " +
				"enabled INTEGER NOT NULL DEFAULT 1, group_name TEXT);" +
				"INSERT INTO _emdash_redirects (id, source, destination, is_pattern) " +
				"VALUES ('pattern', '/docs/[slug]', '/guides/[slug]', 1)",
		);
		db = new Kysely<unknown>({ dialect: new SqliteDialect({ database: sqlite }) });

		await up(db);

		await expect(
			sql`
				INSERT INTO _emdash_redirects (id, source, destination)
				VALUES ('legacy-exact', '/old', '/new')
			`.execute(db),
		).resolves.toBeDefined();
		await expect(
			sql`
				UPDATE _emdash_redirects SET destination = '/newer'
				WHERE id = 'legacy-exact'
			`.execute(db),
		).resolves.toBeDefined();
		await expect(
			sql`
				INSERT INTO _emdash_redirects (id, source, destination, is_pattern)
				VALUES ('legacy-pattern', '/news/[slug]', '/articles/[slug]', 1)
			`.execute(db),
		).resolves.toBeDefined();
	});
});
