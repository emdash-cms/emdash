import BetterSqlite3 from "better-sqlite3";
import type { Kysely } from "kysely";
import { Kysely as KyselyCtor, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/database/connection.js";
import { down, up } from "../../../../src/database/migrations/040_byline_i18n.js";
import type { Database } from "../../../../src/database/types.js";
import { setI18nConfig } from "../../../../src/i18n/config.js";

/**
 * Build a Kysely instance backed by better-sqlite3 with foreign keys ON and
 * `PRAGMA foreign_keys = OFF` made into a no-op. This simulates Cloudflare
 * D1's behavior, where FKs are always enforced and the standard escape hatch
 * is silently ignored. Used to verify regressions for #1021 — bugs that only
 * surface when FK enforcement can't be turned off mid-transaction.
 */
function createD1LikeDatabase(): Kysely<Database> {
	const sqlite = new BetterSqlite3(":memory:");
	sqlite.pragma("foreign_keys = ON");
	const originalPrepare = sqlite.prepare.bind(sqlite);
	sqlite.prepare = ((source: string) => {
		if (/^\s*PRAGMA\s+foreign_keys\s*=/i.test(source)) {
			return originalPrepare("SELECT 1") as ReturnType<typeof originalPrepare>;
		}
		return originalPrepare(source);
	}) as typeof sqlite.prepare;
	const dialect = new SqliteDialect({ database: sqlite });
	return new KyselyCtor<Database>({ dialect });
}

/**
 * Seed the byline tables in their pre-040 shape (matching migration 031's
 * schema) plus the support tables 040 reads (`_emdash_collections`, `ec_*`,
 * `users`, `media`).
 */
async function seedPreMigrationSchema(db: Kysely<Database>): Promise<void> {
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

	await sql`
		CREATE TABLE ec_posts (
			id TEXT PRIMARY KEY,
			primary_byline_id TEXT
		)
	`.execute(db);
}

describe("040_byline_i18n migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await seedPreMigrationSchema(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("up()", () => {
		it("adds locale + translation_group to _emdash_bylines", async () => {
			await up(db);

			const tables = await db.introspection.getTables();
			const cols =
				tables.find((t) => t.name === "_emdash_bylines")?.columns.map((c) => c.name) ?? [];
			expect(cols).toContain("locale");
			expect(cols).toContain("translation_group");
		});

		it("creates locale + translation_group indexes on _emdash_bylines", async () => {
			await up(db);

			const indexes = await sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'
			`.execute(db);
			const names = new Set(indexes.rows.map((r) => r.name));

			expect(names).toContain("idx__emdash_bylines_locale");
			expect(names).toContain("idx__emdash_bylines_translation_group");
		});

		it("backfills locale=defaultLocale and translation_group=id for pre-existing rows", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);

			await up(db);

			const row = await sql<{ locale: string; translation_group: string | null }>`
				SELECT locale, translation_group FROM _emdash_bylines WHERE id = 'b1'
			`.execute(db);
			expect(row.rows[0]?.locale).toBe("en");
			expect(row.rows[0]?.translation_group).toBe("b1");
		});

		it("widens the byline unique key from (slug) to (slug, locale)", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);
			await up(db);

			// Same slug, different locale must now be allowed.
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b2', 'jane', 'Jane Doe DE', 'de', 'b1')
			`.execute(db);

			// Same slug AND same locale still conflicts.
			await expect(
				sql`
					INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
					VALUES ('b3', 'jane', 'Jane Other DE', 'de', 'b1')
				`.execute(db),
			).rejects.toThrow();
		});

		it("widens the user_id partial unique from (user_id) to (user_id, locale)", async () => {
			await sql`INSERT INTO users (id) VALUES ('u1')`.execute(db);
			await up(db);

			// One byline per locale per user is allowed.
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, user_id, locale, translation_group)
				VALUES ('b1', 'jane', 'Jane Doe', 'u1', 'en', 'b1')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, user_id, locale, translation_group)
				VALUES ('b2', 'jane', 'Jane Doe DE', 'u1', 'de', 'b1')
			`.execute(db);

			// Two bylines for the same (user_id, locale) must still fail.
			await expect(
				sql`
					INSERT INTO _emdash_bylines (id, slug, display_name, user_id, locale, translation_group)
					VALUES ('b3', 'jane-alt', 'Jane Alt', 'u1', 'en', 'b3')
				`.execute(db),
			).rejects.toThrow();
		});

		it("drops the FK on _emdash_content_bylines.byline_id", async () => {
			await up(db);

			const fks = await sql<{ table: string }>`
				PRAGMA foreign_key_list(_emdash_content_bylines)
			`.execute(db);
			expect(fks.rows).toHaveLength(0);
		});

		it("preserves _emdash_content_bylines rows on D1 (regression for #1021)", async () => {
			// On D1 where `PRAGMA foreign_keys = OFF` is a no-op, dropping the
			// old `_emdash_bylines` table would cascade ON DELETE CASCADE
			// through the original FK and wipe credits. rebuildContentBylines
			// strips the FK *before* `_emdash_bylines` is rebuilt so the drop
			// can't cascade.
			await db.destroy();
			db = createD1LikeDatabase();
			await seedPreMigrationSchema(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_content_bylines (id, collection_slug, content_id, byline_id)
				VALUES ('cb1', 'posts', 'p1', 'b1')
			`.execute(db);

			await up(db);

			const count = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_content_bylines WHERE content_id = 'p1'
			`.execute(db);
			expect(Number(count.rows[0]?.count ?? 0)).toBe(1);
		});

		it("preserves ec_*.primary_byline_id semantically (row id == translation_group on fresh install)", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);
			await sql`INSERT INTO _emdash_collections (slug) VALUES ('posts')`.execute(db);
			await sql`
				INSERT INTO ec_posts (id, primary_byline_id) VALUES ('p1', 'b1')
			`.execute(db);

			await up(db);

			const row = await sql<{ primary_byline_id: string | null }>`
				SELECT primary_byline_id FROM ec_posts WHERE id = 'p1'
			`.execute(db);
			// Value looks unchanged because translation_group == id on fresh
			// install, but the semantics flip: this is now a translation_group
			// reference, not a row id.
			expect(row.rows[0]?.primary_byline_id).toBe("b1");
		});

		it("is idempotent (running twice is safe)", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);

			await up(db);
			await expect(up(db)).resolves.not.toThrow();

			// Existing row survives both passes.
			const row = await sql<{ locale: string; translation_group: string | null }>`
				SELECT locale, translation_group FROM _emdash_bylines WHERE id = 'b1'
			`.execute(db);
			expect(row.rows[0]?.locale).toBe("en");
			expect(row.rows[0]?.translation_group).toBe("b1");
		});

		it("leaves orphan primary_byline_id pointers untouched", async () => {
			await sql`INSERT INTO _emdash_collections (slug) VALUES ('posts')`.execute(db);
			// Post references a byline id that doesn't exist — should not be cleared.
			await sql`
				INSERT INTO ec_posts (id, primary_byline_id) VALUES ('p1', 'b-missing')
			`.execute(db);

			await up(db);

			const row = await sql<{ primary_byline_id: string | null }>`
				SELECT primary_byline_id FROM ec_posts WHERE id = 'p1'
			`.execute(db);
			expect(row.rows[0]?.primary_byline_id).toBe("b-missing");
		});
	});

	describe("down()", () => {
		it("reverts cleanly on a single-locale install", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);
			await up(db);

			await down(db);

			const tables = await db.introspection.getTables();
			const cols =
				tables.find((t) => t.name === "_emdash_bylines")?.columns.map((c) => c.name) ?? [];
			expect(cols).not.toContain("locale");
			expect(cols).not.toContain("translation_group");

			// Original row survived.
			const row = await sql<{ slug: string; display_name: string }>`
				SELECT slug, display_name FROM _emdash_bylines WHERE id = 'b1'
			`.execute(db);
			expect(row.rows[0]?.slug).toBe("jane");
			expect(row.rows[0]?.display_name).toBe("Jane Doe");

			// FK restored on _emdash_content_bylines.byline_id.
			const fks = await sql<{ table: string }>`
				PRAGMA foreign_key_list(_emdash_content_bylines)
			`.execute(db);
			expect(fks.rows.length).toBeGreaterThan(0);
		});

		it("refuses to rollback when non-default-locale rows exist", async () => {
			await up(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b-fr', 'jane', 'Jeanne', 'fr', 'b-fr')
			`.execute(db);

			await expect(down(db)).rejects.toThrow(/non-default locale/i);

			// Assertion fired before any destructive work — schema still post-up.
			const cols = (await db.introspection.getTables())
				.find((t) => t.name === "_emdash_bylines")
				?.columns.map((c) => c.name);
			expect(cols).toContain("locale");
		});

		it("refuses to rollback when _emdash_content_bylines has dangling rows", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_content_bylines (id, collection_slug, content_id, byline_id)
				VALUES ('cb1', 'posts', 'p1', 'b1')
			`.execute(db);
			await up(db);
			// Delete the byline row, leaving _emdash_content_bylines pointing at a
			// translation_group with no anchor row. (Possible because up()
			// removed the cascading FK.)
			await sql`DELETE FROM _emdash_bylines WHERE id = 'b1'`.execute(db);

			await expect(down(db)).rejects.toThrow(/_emdash_content_bylines/);

			// Assertion fired before any destructive work.
			const cols = (await db.introspection.getTables())
				.find((t) => t.name === "_emdash_bylines")
				?.columns.map((c) => c.name);
			expect(cols).toContain("locale");
		});

		it("preserves _emdash_content_bylines rows on D1 rollback (regression for #1021)", async () => {
			// down() rebuilds _emdash_bylines before restoring the FK on
			// _emdash_content_bylines. The intermediate state must not
			// cascade — neither table has an FK pointing at the other while
			// the rebuild is in flight.
			await db.destroy();
			db = createD1LikeDatabase();
			await seedPreMigrationSchema(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_content_bylines (id, collection_slug, content_id, byline_id)
				VALUES ('cb1', 'posts', 'p1', 'b1')
			`.execute(db);
			await up(db);

			await down(db);

			const count = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_content_bylines WHERE content_id = 'p1'
			`.execute(db);
			expect(Number(count.rows[0]?.count ?? 0)).toBe(1);
		});
	});

	describe("with non-default locale (defaultLocale='es')", () => {
		beforeEach(() => {
			setI18nConfig({ defaultLocale: "es", locales: ["es", "en"] });
		});

		afterEach(() => {
			setI18nConfig(null);
		});

		it("backfills pre-existing rows with the configured defaultLocale", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);

			await up(db);

			const row = await sql<{ locale: string }>`
				SELECT locale FROM _emdash_bylines WHERE id = 'b1'
			`.execute(db);
			expect(row.rows[0]?.locale).toBe("es");
		});

		it("rolls back cleanly when only defaultLocale rows exist", async () => {
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name)
				VALUES ('b1', 'jane', 'Jane Doe')
			`.execute(db);
			await up(db);

			await expect(down(db)).resolves.not.toThrow();

			const cols = (await db.introspection.getTables())
				.find((t) => t.name === "_emdash_bylines")
				?.columns.map((c) => c.name);
			expect(cols).not.toContain("locale");
		});

		it("blocks rollback when rows use a locale other than the configured default", async () => {
			await up(db);
			await sql`
				INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
				VALUES ('b-en', 'jane', 'Jane Doe', 'en', 'b-en')
			`.execute(db);

			await expect(down(db)).rejects.toThrow(/defaultLocale="es"/);
		});
	});
});
