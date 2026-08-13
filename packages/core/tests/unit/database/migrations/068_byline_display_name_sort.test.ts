import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/database/connection.js";
import { columnExists } from "../../../../src/database/dialect-helpers.js";
import { down, up } from "../../../../src/database/migrations/068_byline_display_name_sort.js";
import type { Database } from "../../../../src/database/types.js";

/** `_emdash_bylines` reduced to the columns 068 reads and writes. */
async function seedBylinesTable(db: Kysely<Database>): Promise<void> {
	await sql`
		CREATE TABLE _emdash_bylines (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			display_name TEXT NOT NULL
		)
	`.execute(db);
}

async function insertByline(db: Kysely<Database>, id: string, displayName: string): Promise<void> {
	await sql`
		INSERT INTO _emdash_bylines (id, slug, display_name)
		VALUES (${id}, ${id}, ${displayName})
	`.execute(db);
}

async function sortKeys(db: Kysely<Database>): Promise<Record<string, string>> {
	const { rows } = await sql<{ id: string; display_name_sort: string }>`
		SELECT id, display_name_sort FROM _emdash_bylines
	`.execute(db);
	return Object.fromEntries(rows.map((row) => [row.id, row.display_name_sort]));
}

describe("068_byline_display_name_sort migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await seedBylinesTable(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("fills the sort key for rows that predate the column", async () => {
		await insertByline(db, "b1", "Zoe Vance");
		await insertByline(db, "b2", "alice cooper");
		await insertByline(db, "b3", "Álvaro Núñez");
		await insertByline(db, "b4", "Øyvind Berg");

		await up(db);

		expect(await sortKeys(db)).toEqual({
			b1: "zoe vance",
			b2: "alice cooper",
			b3: "alvaro nunez",
			b4: "oyvind berg",
		});
	});

	it("backfills every row when there are more than fit in one statement", async () => {
		// The backfill batches rows to stay inside D1's bound-parameter ceiling;
		// a row in a later batch is the one an off-by-one drops.
		for (let i = 0; i < 70; i++) {
			await insertByline(db, `b${i}`, `Author ${i}`);
		}

		await up(db);

		const keys = await sortKeys(db);
		expect(Object.keys(keys)).toHaveLength(70);
		expect(Object.values(keys).filter((key) => key === "")).toEqual([]);
		expect(keys.b69).toBe("author 69");
	});

	it("re-runs against a database that already has the column", async () => {
		await insertByline(db, "b1", "Zoe Vance");
		await up(db);
		await insertByline(db, "b2", "Adam Bell");

		await up(db);

		expect(await sortKeys(db)).toEqual({ b1: "zoe vance", b2: "adam bell" });
	});

	it("down() drops the column", async () => {
		await insertByline(db, "b1", "Zoe Vance");
		await up(db);

		await down(db);

		expect(await columnExists(db, "_emdash_bylines", "display_name_sort")).toBe(false);
	});
});
