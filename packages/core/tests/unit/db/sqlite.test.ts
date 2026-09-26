import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kysely, sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { createDialect } from "../../../src/db/sqlite.js";

describe("sqlite runtime adapter", () => {
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	function temporaryDatabaseUrl(): string {
		const directory = mkdtempSync(join(tmpdir(), "emdash-sqlite-adapter-"));
		temporaryDirectories.push(directory);
		return `file:${join(directory, "data.db")}`;
	}

	it("opens a fresh database file in WAL mode", async () => {
		const db = new Kysely<Record<string, never>>({
			dialect: createDialect({ url: temporaryDatabaseUrl() }),
		});

		try {
			const { rows } = await sql<{
				journal_mode: string;
			}>`PRAGMA journal_mode`.execute(db);
			expect(rows).toEqual([{ journal_mode: "wal" }]);

			const synchronous = await sql<{ synchronous: number }>`PRAGMA synchronous`.execute(db);
			expect(synchronous.rows).toEqual([{ synchronous: 1 }]);
		} finally {
			await db.destroy();
		}
	});
});
