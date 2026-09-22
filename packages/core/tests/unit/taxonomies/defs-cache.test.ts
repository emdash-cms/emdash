/**
 * Isolate-wide taxonomy-definitions cache (perf: removes the per-render
 * `SELECT * FROM _emdash_taxonomy_defs` on warm isolates).
 *
 * The cache lives on globalThis and is keyed by resolved locale. Because
 * `requestCached` dedupes within a single request scope, we exercise the
 * isolate cache by running each `getTaxonomyDefs()` call inside its own
 * `runWithContext` scope (a fresh context object => a fresh per-request
 * cache bucket), so a second call only avoids the DB if the *isolate*
 * cache served it.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import {
	getTaxonomyDefs,
	invalidateTaxonomyDefsCache,
	resetTaxonomyDefsCacheForTests,
} from "../../../src/taxonomies/index.js";

let queryCount = 0;

function makeDb(): { db: Kysely<EmDashDatabase>; sqlite: Database.Database } {
	const sqlite = new Database(":memory:");
	const db = new Kysely<EmDashDatabase>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query" && event.query.sql.includes("_emdash_taxonomy_defs")) {
				queryCount += 1;
			}
		},
	});
	return { db, sqlite };
}

async function insertDef(db: Kysely<EmDashDatabase>, name: string): Promise<void> {
	await db
		.insertInto("_emdash_taxonomy_defs")
		.values({
			id: ulid(),
			name,
			label: name,
			label_singular: null,
			hierarchical: 0,
			collections: JSON.stringify(["posts"]),
		})
		.execute();
}

/** Run a getter in a fresh per-request scope with the test db as the ALS db. */
function inScope<T>(
	db: Kysely<EmDashDatabase>,
	fn: () => Promise<T>,
	opts?: { dbIsIsolated?: boolean },
): Promise<T> {
	return runWithContext({ editMode: false, db, ...opts }, fn);
}

describe("getTaxonomyDefs — isolate cache", () => {
	let db: Kysely<EmDashDatabase>;
	let sqlite: Database.Database;

	beforeEach(async () => {
		({ db, sqlite } = makeDb());
		await runMigrations(db);
		// Holder lives on globalThis; reset so sibling tests don't leak the
		// previous test's db/promise into this one.
		resetTaxonomyDefsCacheForTests();
		await insertDef(db, "genre");
		queryCount = 0;
	});

	afterEach(async () => {
		await db.destroy();
		sqlite.close();
	});

	it("queries once per isolate, serving later requests from cache", async () => {
		const first = await inScope(db, () => getTaxonomyDefs());
		expect(queryCount).toBe(1);
		expect(first.map((d) => d.name)).toContain("genre");

		// A separate request scope: per-request cache can't help, so a second
		// query would fire unless the isolate cache served it.
		const second = await inScope(db, () => getTaxonomyDefs());
		expect(queryCount).toBe(1);
		expect(second.map((d) => d.name).toSorted()).toEqual(first.map((d) => d.name).toSorted());
	});

	it("re-queries after invalidateTaxonomyDefsCache()", async () => {
		await inScope(db, () => getTaxonomyDefs());
		expect(queryCount).toBe(1);

		invalidateTaxonomyDefsCache();

		await inScope(db, () => getTaxonomyDefs());
		expect(queryCount).toBe(2);
	});

	it("reflects a newly inserted def only after invalidation (in-memory invalidation semantics)", async () => {
		const before = await inScope(db, () => getTaxonomyDefs());
		expect(before.map((d) => d.name)).not.toContain("topic");

		await insertDef(db, "topic");

		// Still cached — stale read is expected without an explicit bump.
		const stale = await inScope(db, () => getTaxonomyDefs());
		expect(stale.map((d) => d.name)).not.toContain("topic");

		invalidateTaxonomyDefsCache();

		const fresh = await inScope(db, () => getTaxonomyDefs());
		expect(fresh.map((d) => d.name)).toContain("topic");
	});

	it("bypasses the isolate cache for isolated databases (playground / DO preview)", async () => {
		await inScope(db, () => getTaxonomyDefs(), { dbIsIsolated: true });
		await inScope(db, () => getTaxonomyDefs(), { dbIsIsolated: true });
		// Never cached across requests => one query each.
		expect(queryCount).toBe(2);
	});
});
