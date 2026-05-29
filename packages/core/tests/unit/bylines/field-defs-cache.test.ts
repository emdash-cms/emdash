/**
 * Byline field-definitions cache — dirty-version bypass and
 * concurrent-collapse defense (#1174 review BUG 1 and follow-up).
 * Tests poke the version row directly to reproduce crash and race
 * states without orchestrating a real process crash.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getBylineFieldDefs,
	resetBylineFieldDefsCacheForTests,
} from "../../../src/bylines/field-defs-cache.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { BylineSchemaRegistry } from "../../../src/schema/byline-registry.js";

const VERSION_KEY = "byline_fields_version";

async function setVersion(db: Kysely<EmDashDatabase>, value: number): Promise<void> {
	await sql`
		INSERT INTO options (name, value)
		VALUES (${VERSION_KEY}, ${String(value)})
		ON CONFLICT(name) DO UPDATE SET value = ${String(value)}
	`.execute(db);
}

async function insertFieldDirect(
	db: Kysely<EmDashDatabase>,
	slug: string,
	label = slug,
): Promise<void> {
	await db
		.insertInto("_emdash_byline_fields")
		.values({
			id: ulid(),
			slug,
			label,
			type: "string",
			required: 0,
			translatable: 1,
			validation: null,
			sort_order: 0,
		})
		.execute();
}

describe("getBylineFieldDefs — dirty-version bypass (#1174 BUG 1)", () => {
	let db: Kysely<EmDashDatabase>;

	beforeEach(async () => {
		const sqlite = new Database(":memory:");
		db = new Kysely<EmDashDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);
		// Holder lives on globalThis; reset so siblings don't leak state.
		resetBylineFieldDefsCacheForTests();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("returns fresh defs when the global cache was primed under the same odd version", async () => {
		// Reproduces BUG 1: cache primed at odd version V with pre-insert
		// defs, then the insert lands but V never advances — readers
		// pinned on V would see stale defs forever without bypass.
		await setVersion(db, 11);
		const beforeInsert = await getBylineFieldDefs(db);
		expect(beforeInsert).toHaveLength(0);

		// Insert lands but the second bump doesn't.
		await insertFieldDirect(db, "ghost_field");

		// Without bypass the cache returns []; with it, odd forces a DB read.
		const afterInsert = await getBylineFieldDefs(db);
		expect(afterInsert.map((f) => f.slug)).toContain("ghost_field");
	});

	it("does not write the global holder while the version is odd", async () => {
		await setVersion(db, 0);
		await getBylineFieldDefs(db);

		await setVersion(db, 1);
		await insertFieldDirect(db, "in_flight_field");
		await getBylineFieldDefs(db);

		await setVersion(db, 2);
		await insertFieldDirect(db, "after_clean_field");

		const final = await getBylineFieldDefs(db);
		expect(final.map((f) => f.slug).toSorted()).toEqual(["after_clean_field", "in_flight_field"]);
	});

	it("a second concurrent mutator's markClean still advances the version (no concurrent-collapse)", async () => {
		// Reproduces the concurrent-collapse race by interleaving raw
		// bookend SQL. Without always-advance markClean, B's clean would
		// no-op on the already-even version, leaving the cache pinned on
		// A's snapshot indefinitely.
		await setVersion(db, 0);
		resetBylineFieldDefsCacheForTests();
		expect(await getBylineFieldDefs(db)).toHaveLength(0);

		// A markDirty.
		await sql`
			UPDATE options SET value = '1' WHERE name = ${VERSION_KEY}
		`.execute(db);
		// B markDirty (idempotent — no change).
		await sql`
			UPDATE options SET value = CASE WHEN CAST(value AS INTEGER) % 2 = 0
				THEN CAST(CAST(value AS INTEGER) + 1 AS TEXT)
				ELSE value END
			WHERE name = ${VERSION_KEY}
		`.execute(db);
		expect(await new BylineSchemaRegistry(db).getVersion()).toBe(1);

		// A inserts + clean (1 → 2). Reader caches [a] at cachedVersion=2.
		await insertFieldDirect(db, "field_a");
		await sql`
			UPDATE options SET value = '2' WHERE name = ${VERSION_KEY}
		`.execute(db);
		expect((await getBylineFieldDefs(db)).map((f) => f.slug)).toEqual(["field_a"]);

		// B inserts. B's markClean uses the production always-advance CASE.
		await insertFieldDirect(db, "field_b");
		await sql`
			UPDATE options SET value = CASE WHEN CAST(value AS INTEGER) % 2 = 0
				THEN CAST(CAST(value AS INTEGER) + 2 AS TEXT)
				ELSE CAST(CAST(value AS INTEGER) + 1 AS TEXT) END
			WHERE name = ${VERSION_KEY}
		`.execute(db);

		expect((await getBylineFieldDefs(db)).map((f) => f.slug).toSorted()).toEqual([
			"field_a",
			"field_b",
		]);
	});

	it("missing version row does not silently make cache invalidation a no-op", async () => {
		// Cold-start case: helpers must upsert, not bare UPDATE, so a
		// missing row still flips parity.
		await db.deleteFrom("options").where("name", "=", VERSION_KEY).execute();

		expect(await getBylineFieldDefs(db)).toHaveLength(0);

		await setVersion(db, 1);
		await insertFieldDirect(db, "first_field");

		expect((await getBylineFieldDefs(db)).map((f) => f.slug)).toContain("first_field");
	});
});
