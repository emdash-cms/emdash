import BetterSqlite3 from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { down, up } from "../../../../src/database/migrations/059_revision_prune_queue.js";

describe("059_revision_prune_queue migration", () => {
	let db: Kysely<Record<string, never>> | undefined;

	afterEach(async () => {
		await db?.destroy();
	});

	it("queues existing excessive histories and can be retried", async () => {
		const sqlite = new BetterSqlite3(":memory:");
		sqlite.exec(`
			CREATE TABLE revisions (
				id TEXT PRIMARY KEY,
				collection TEXT NOT NULL,
				entry_id TEXT NOT NULL
			)
		`);
		const insert = sqlite.prepare(
			"INSERT INTO revisions (id, collection, entry_id) VALUES (?, ?, ?)",
		);
		for (let i = 0; i < 51; i++) insert.run(String(i).padStart(2, "0"), "post", "entry-1");

		db = new Kysely<Record<string, never>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});

		await up(db);
		await up(db);

		const queued = await sql<{ collection: string; entry_id: string; revision_id: string }>`
			SELECT collection, entry_id, revision_id
			FROM _emdash_revision_prune_queue
		`.execute(db);
		expect(queued.rows).toEqual([{ collection: "post", entry_id: "entry-1", revision_id: "50" }]);

		await down(db);
	});
});
