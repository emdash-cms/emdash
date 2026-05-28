import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/database/connection.js";
import { up as up040 } from "../../../../src/database/migrations/040_byline_i18n.js";
import { down, up } from "../../../../src/database/migrations/041_byline_fields.js";
import type { Database } from "../../../../src/database/types.js";

/**
 * Seed the pre-041 schema: byline tables in their post-040 shape, plus the
 * `options` table the version-counter row writes to. 041 doesn't touch
 * `_emdash_content_bylines` or `ec_*`, but 040 needs the support tables to
 * apply — set them up so the "applies on a #1146-era DB" case is exercised
 * the same way as a real upgrade.
 */
async function seedPostMigration040Schema(db: Kysely<Database>): Promise<void> {
	await sql`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			email TEXT
		)
	`.execute(db);

	await sql`
		CREATE TABLE media (
			id TEXT PRIMARY KEY
		)
	`.execute(db);

	await sql`
		CREATE TABLE options (
			name TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`.execute(db);

	// _emdash_bylines in its pre-040 shape; up040 will widen it.
	await sql`
		CREATE TABLE _emdash_bylines (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			bio TEXT,
			avatar_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
			website_url TEXT,
			user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			is_guest INTEGER NOT NULL DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)
	`.execute(db);

	await sql`
		CREATE UNIQUE INDEX idx_bylines_user_id_unique
		ON _emdash_bylines (user_id) WHERE user_id IS NOT NULL
	`.execute(db);
	await sql`CREATE INDEX idx_bylines_slug ON _emdash_bylines(slug)`.execute(db);
	await sql`CREATE INDEX idx_bylines_display_name ON _emdash_bylines(display_name)`.execute(db);

	await sql`
		CREATE TABLE _emdash_content_bylines (
			id TEXT PRIMARY KEY,
			collection_slug TEXT NOT NULL,
			content_id TEXT NOT NULL,
			byline_id TEXT NOT NULL REFERENCES _emdash_bylines(id) ON DELETE CASCADE,
			sort_order INTEGER NOT NULL DEFAULT 0,
			role_label TEXT,
			created_at TEXT DEFAULT (datetime('now')),
			UNIQUE(collection_slug, content_id, byline_id)
		)
	`.execute(db);

	await sql`
		CREATE INDEX idx_content_bylines_content
		ON _emdash_content_bylines(collection_slug, content_id, sort_order)
	`.execute(db);
	await sql`
		CREATE INDEX idx_content_bylines_byline
		ON _emdash_content_bylines(byline_id)
	`.execute(db);

	await sql`
		CREATE TABLE _emdash_collections (
			slug TEXT PRIMARY KEY
		)
	`.execute(db);

	await up040(db);
}

async function tableNames(db: Kysely<Database>): Promise<Set<string>> {
	const tables = await db.introspection.getTables();
	return new Set(tables.map((t) => t.name));
}

async function indexNames(db: Kysely<Database>): Promise<Set<string>> {
	const rows = await sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'
	`.execute(db);
	return new Set(rows.rows.map((r) => r.name));
}

async function getVersionRow(db: Kysely<Database>): Promise<string | null> {
	const row = await sql<{ value: string }>`
		SELECT value FROM options WHERE name = 'byline_fields_version'
	`.execute(db);
	return row.rows[0]?.value ?? null;
}

describe("041_byline_fields migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await seedPostMigration040Schema(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("up()", () => {
		it("creates the three byline-field tables", async () => {
			await up(db);

			const names = await tableNames(db);
			expect(names).toContain("_emdash_byline_fields");
			expect(names).toContain("_emdash_byline_field_values");
			expect(names).toContain("_emdash_byline_field_group_values");
		});

		it("creates expected indexes", async () => {
			await up(db);

			const names = await indexNames(db);
			expect(names).toContain("idx__emdash_byline_fields_sort_order");
			expect(names).toContain("idx__emdash_byline_field_values_byline");
			expect(names).toContain("idx__emdash_byline_field_values_field");
			expect(names).toContain("idx__emdash_byline_field_group_values_group");
			expect(names).toContain("idx__emdash_byline_field_group_values_field");
		});

		it("inserts the byline_fields_version counter into options", async () => {
			await up(db);

			// `options.value` stores JSON; the initial counter is the JSON
			// literal `0`. Phase 3's cache parses with JSON.parse and reads
			// it as `number 0`.
			expect(await getVersionRow(db)).toBe("0");
		});

		it("_emdash_byline_fields enforces slug uniqueness", async () => {
			await up(db);

			await sql`
				INSERT INTO _emdash_byline_fields (id, slug, label, type)
				VALUES ('f1', 'job_title', 'Job title', 'string')
			`.execute(db);

			await expect(
				sql`
					INSERT INTO _emdash_byline_fields (id, slug, label, type)
					VALUES ('f2', 'job_title', 'Other label', 'string')
				`.execute(db),
			).rejects.toThrow();
		});

		it("translatable defaults to 1 (per-locale storage is the default)", async () => {
			await up(db);

			await sql`
				INSERT INTO _emdash_byline_fields (id, slug, label, type)
				VALUES ('f1', 'job_title', 'Job title', 'string')
			`.execute(db);

			const row = await sql<{ translatable: number; required: number; sort_order: number }>`
				SELECT translatable, required, sort_order FROM _emdash_byline_fields WHERE id = 'f1'
			`.execute(db);
			expect(row.rows[0]?.translatable).toBe(1);
			expect(row.rows[0]?.required).toBe(0);
			expect(row.rows[0]?.sort_order).toBe(0);
		});

		it("_emdash_byline_field_values composite PK rejects duplicate (byline_id, field_id)", async () => {
			await up(db);

			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane Doe', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_fields (id, slug, label, type)
				VALUES ('f1', 'job_title', 'Job title', 'string')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES ('b1', 'f1', '"Editor"')
			`.execute(db);

			await expect(
				sql`
					INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
					VALUES ('b1', 'f1', '"Senior Editor"')
				`.execute(db),
			).rejects.toThrow();
		});

		it("_emdash_byline_field_group_values composite PK rejects duplicate (translation_group, field_id)", async () => {
			await up(db);

			await sql`
				INSERT INTO _emdash_byline_fields (id, slug, label, type, translatable)
				VALUES ('f1', 'twitter_handle', 'Twitter', 'string', 0)
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES ('g1', 'f1', '"@jane"')
			`.execute(db);

			await expect(
				sql`
					INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
					VALUES ('g1', 'f1', '"@other"')
				`.execute(db),
			).rejects.toThrow();
		});

		it("ON DELETE CASCADE: deleting a byline removes its translatable values", async () => {
			await up(db);

			await sql`PRAGMA foreign_keys = ON`.execute(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane Doe', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_fields (id, slug, label, type)
				VALUES ('f1', 'job_title', 'Job title', 'string')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES ('b1', 'f1', '"Editor"')
			`.execute(db);

			await sql`DELETE FROM _emdash_bylines WHERE id = 'b1'`.execute(db);

			const remaining = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
			`.execute(db);
			expect(Number(remaining.rows[0]?.count ?? -1)).toBe(0);
		});

		it("ON DELETE CASCADE: deleting a field removes its translatable AND group-shared values", async () => {
			await up(db);

			await sql`PRAGMA foreign_keys = ON`.execute(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane Doe', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_fields (id, slug, label, type)
				VALUES ('f1', 'job_title', 'Job title', 'string')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES ('b1', 'f1', '"Editor"')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES ('b1', 'f1', '"@jane"')
			`.execute(db);

			await sql`DELETE FROM _emdash_byline_fields WHERE id = 'f1'`.execute(db);

			const trCount = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
			`.execute(db);
			expect(Number(trCount.rows[0]?.count ?? -1)).toBe(0);
			const grpCount = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_group_values
			`.execute(db);
			expect(Number(grpCount.rows[0]?.count ?? -1)).toBe(0);
		});

		it("is idempotent on partial re-application (table-exists guard)", async () => {
			await up(db);

			// Simulate a crashed partial prior run: tables exist but the
			// version row is gone. `INSERT … ON CONFLICT DO NOTHING` should
			// leave existing state untouched if present, restore if missing.
			await sql`DELETE FROM options WHERE name = 'byline_fields_version'`.execute(db);

			await expect(up(db)).resolves.not.toThrow();
			expect(await getVersionRow(db)).toBe("0");
		});

		it("recreates missing indexes when a crash dropped them mid-up()", async () => {
			// Realistic partial-failure scenario: CREATE TABLE landed in the
			// failed pass, CREATE INDEX did not. A coarse table-level guard
			// would skip the index on retry; per-statement `.ifNotExists()`
			// on the createIndex calls keeps the migration retry-safe (Phase
			// 1 AC: "applies cleanly … on a DB with bylines+content from
			// #1146" includes the partial-failure case).
			await up(db);
			await sql`DROP INDEX idx__emdash_byline_field_values_byline`.execute(db);
			await sql`DROP INDEX idx__emdash_byline_field_group_values_group`.execute(db);

			await expect(up(db)).resolves.not.toThrow();

			const names = await indexNames(db);
			expect(names).toContain("idx__emdash_byline_field_values_byline");
			expect(names).toContain("idx__emdash_byline_field_group_values_group");
		});

		it("preserves a non-zero version counter on re-application", async () => {
			await up(db);
			// Simulate post-cache-bump state: version has been incremented by
			// a registry mutation (Phase 2). A second `up()` (recovery path)
			// must not reset it.
			await sql`
				UPDATE options SET value = '5' WHERE name = 'byline_fields_version'
			`.execute(db);

			await up(db);

			expect(await getVersionRow(db)).toBe("5");
		});
	});

	describe("down()", () => {
		it("drops all three tables and removes the version row", async () => {
			await up(db);
			await down(db);

			const names = await tableNames(db);
			expect(names).not.toContain("_emdash_byline_fields");
			expect(names).not.toContain("_emdash_byline_field_values");
			expect(names).not.toContain("_emdash_byline_field_group_values");
			expect(await getVersionRow(db)).toBeNull();
		});

		it("up -> down -> up settles to the same state as a single up", async () => {
			await up(db);
			await down(db);
			await up(db);

			const names = await tableNames(db);
			expect(names).toContain("_emdash_byline_fields");
			expect(names).toContain("_emdash_byline_field_values");
			expect(names).toContain("_emdash_byline_field_group_values");
			expect(await getVersionRow(db)).toBe("0");
		});

		it("tolerates running on a partially-applied up() (missing tables)", async () => {
			// No tables created — down() should still be a no-op rather than throw.
			await expect(down(db)).resolves.not.toThrow();
		});
	});
});
