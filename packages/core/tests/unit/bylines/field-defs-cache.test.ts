/**
 * Byline field-definitions cache — dirty-version bypass and
 * concurrent-collapse defense (#1174 review BUG 1 and follow-up).
 * Tests poke the version row directly to reproduce crash and race
 * states without orchestrating a real process crash.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		vi.restoreAllMocks();
		await db.destroy();
	});

	it("coalesces concurrent cold global reads on the same in-flight defs promise", async () => {
		await insertFieldDirect(db, "shared_field");

		const original = BylineSchemaRegistry.prototype.listFields;
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		vi.spyOn(BylineSchemaRegistry.prototype, "listFields").mockImplementation(async function (
			this: BylineSchemaRegistry,
		) {
			calls += 1;
			await gate;
			return original.call(this);
		});

		const first = getBylineFieldDefs(db);
		const second = getBylineFieldDefs(db);

		release();
		const results = await Promise.all([first, second]);

		expect(calls).toBe(1);
		expect(results[0].map((f) => f.slug)).toEqual(["shared_field"]);
		expect(results[1].map((f) => f.slug)).toEqual(["shared_field"]);
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

	it("missing version row: production markVersionDirty path initialises the row and busts the cache", async () => {
		// Drives invalidation through the registry helper, not the local
		// `setVersion`, which would upsert the row regardless. Skipping
		// `markVersionClean` keeps a bare-UPDATE regression in
		// `markVersionDirty` from being masked by clean's own upsert.
		await db.deleteFrom("options").where("name", "=", VERSION_KEY).execute();
		expect(await getBylineFieldDefs(db)).toHaveLength(0);

		const registry = new BylineSchemaRegistry(db);
		const r = registry as unknown as { markVersionDirty(): Promise<void> };
		await r.markVersionDirty();
		await insertFieldDirect(db, "first_field");

		// Odd version → cache bypasses the global holder and re-reads.
		expect(await registry.getVersion()).toBe(1);
		expect((await getBylineFieldDefs(db)).map((f) => f.slug)).toContain("first_field");
	});
});
