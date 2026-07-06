import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../../../src/database/migrations/runner.js";
import type { Database as DatabaseSchema } from "../../../../src/database/types.js";

/**
 * Migration 051 adds the composite `idx_content_taxonomies_term_lookup` on
 * `content_taxonomies(taxonomy_id, collection, entry_id)` (#1834).
 *
 * The PK is `(collection, entry_id, taxonomy_id)` — good for "terms of an
 * entry", useless for driving "entries with a term". The single-column
 * `idx_content_taxonomies_term(taxonomy_id)` is the right idea, but a
 * stats-blind planner won't pick it once `collection = ?` is also present
 * (non-covering for collection/entry_id, so the PK's covering scan wins). The
 * composite seeks by `taxonomy_id` while covering `collection`/`entry_id`, so
 * the planner drives from the selective term without a hint. Its leftmost
 * prefix supersedes the single-column index, which the migration drops.
 */

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
	sqlite = new Database(":memory:");
	db = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
	await runMigrations(db);
});

afterEach(async () => {
	await db.destroy();
});

function indexColumns(name: string): string[] {
	const rows = sqlite.prepare(`PRAGMA index_info(${name})`).all() as { name: string }[];
	return rows.map((r) => r.name);
}

function indexExists(name: string): boolean {
	const row = sqlite
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
		.get(name);
	return row != null;
}

it("creates idx_content_taxonomies_term_lookup on (taxonomy_id, collection, entry_id)", () => {
	expect(indexExists("idx_content_taxonomies_term_lookup")).toBe(true);
	expect(indexColumns("idx_content_taxonomies_term_lookup")).toEqual([
		"taxonomy_id",
		"collection",
		"entry_id",
	]);
});

it("drops the superseded single-column idx_content_taxonomies_term", () => {
	expect(indexExists("idx_content_taxonomies_term")).toBe(false);
});
