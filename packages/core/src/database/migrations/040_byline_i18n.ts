import type { Kysely } from "kysely";
import { sql } from "kysely";

import { getI18nConfig } from "../../i18n/config.js";
import { currentTimestamp, isSqlite, listTablesLike } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

/**
 * i18n for bylines. Adds `locale` + `translation_group` to `_emdash_bylines`
 * and stores translation_groups (not row ids) in
 * `_emdash_content_bylines.byline_id` and `ec_*.primary_byline_id`. Backfill
 * locale and column DEFAULTs use the site's configured defaultLocale.
 *
 * Mirrors the row-per-locale + `translation_group` model PR #916 (migration
 * 036) applied to menus and taxonomies.
 *
 * Key consequences of the model:
 * - `(slug, locale)` is unique on `_emdash_bylines`; a single slug can repeat
 *   across locales (one row per locale variant of a byline).
 * - The partial unique on `user_id` widens to `(user_id, locale)` so a CMS
 *   user can have one byline per locale.
 * - `_emdash_content_bylines.byline_id` no longer FKs to `_emdash_bylines.id`
 *   (it holds a `translation_group`, not a row id). The runtime is
 *   responsible for cascading on byline delete — see `BylineRepository.delete`.
 *
 * Hydration is strict per locale (see `BylineRepository.getContentBylines`):
 * a credit at locale X renders iff a byline row exists at locale X within the
 * credited translation group. This mirrors `getEntryTerms` and the convention
 * established by #916. There is no read-time fallback.
 */

function getDefaultLocale(): string {
	return getI18nConfig()?.defaultLocale ?? "en";
}

export async function up(db: Kysely<unknown>): Promise<void> {
	const defaultLocale = getDefaultLocale();

	if (isSqlite(db)) {
		// Rebuild children before parents to drop FKs that would CASCADE
		// on D1 (#1021). `_emdash_content_bylines.byline_id` has an FK to
		// `_emdash_bylines(id) ON DELETE CASCADE` from migration 031.
		// Stripping it first lets us rebuild `_emdash_bylines` without
		// risking a cascading wipe of credits on D1.
		await rebuildContentBylines(db);
		await rebuildBylines(db, defaultLocale);
		await remapPrimaryBylineIds(db);
		return;
	}

	await pgWidenBylines(db, defaultLocale);
	await pgDropContentBylinesFk(db);
	await remapPrimaryBylineIds(db);
}

async function rebuildContentBylines(db: Kysely<unknown>): Promise<void> {
	// Drops the FK so `byline_id` can point at a translation_group rather
	// than a row id. Runs before `rebuildBylines` so the drop is safe on D1.
	// No remap is needed here: `rebuildBylines` later seeds `translation_group
	// = id` for every preserved row, so the row-id values we copy resolve as
	// translation_group references after the migration completes. This coupling
	// is load-bearing — if the translation_group seed ever changes, this needs
	// an explicit remap *after* `rebuildBylines` runs.
	const fks = await sql<{ id: number }>`PRAGMA foreign_key_list(_emdash_content_bylines)`.execute(
		db,
	);
	if (fks.rows.length === 0) return;

	await sql.raw(`DROP TABLE IF EXISTS "_emdash_content_bylines_new"`).execute(db);
	await db.schema
		.createTable("_emdash_content_bylines_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("collection_slug", "text", (c) => c.notNull())
		.addColumn("content_id", "text", (c) => c.notNull())
		.addColumn("byline_id", "text", (c) => c.notNull())
		.addColumn("sort_order", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("role_label", "text")
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("content_bylines_unique", ["collection_slug", "content_id", "byline_id"])
		.execute();

	await sql`
		INSERT INTO _emdash_content_bylines_new
			(id, collection_slug, content_id, byline_id, sort_order, role_label, created_at)
		SELECT id, collection_slug, content_id, byline_id, sort_order, role_label, created_at
		FROM _emdash_content_bylines
	`.execute(db);

	await db.schema.dropTable("_emdash_content_bylines").execute();
	await sql`ALTER TABLE _emdash_content_bylines_new RENAME TO _emdash_content_bylines`.execute(db);

	// Indexes from migration 031 dropped with the table; restore.
	await db.schema
		.createIndex("idx_content_bylines_content")
		.on("_emdash_content_bylines")
		.columns(["collection_slug", "content_id", "sort_order"])
		.execute();
	await db.schema
		.createIndex("idx_content_bylines_byline")
		.on("_emdash_content_bylines")
		.column("byline_id")
		.execute();
}

async function rebuildBylines(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	if (await hasColumn(db, "_emdash_bylines", "locale")) return;
	await sql.raw(`DROP TABLE IF EXISTS "_emdash_bylines_new"`).execute(db);

	await db.schema
		.createTable("_emdash_bylines_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("slug", "text", (c) => c.notNull())
		.addColumn("display_name", "text", (c) => c.notNull())
		.addColumn("bio", "text")
		.addColumn("avatar_media_id", "text", (c) => c.references("media.id").onDelete("set null"))
		.addColumn("website_url", "text")
		.addColumn("user_id", "text", (c) => c.references("users.id").onDelete("set null"))
		.addColumn("is_guest", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("locale", "text", (c) => c.notNull().defaultTo(defaultLocale))
		.addColumn("translation_group", "text")
		.addUniqueConstraint("_emdash_bylines_slug_locale_unique", ["slug", "locale"])
		.execute();

	await sql`
		INSERT INTO _emdash_bylines_new (
			id, slug, display_name, bio, avatar_media_id, website_url,
			user_id, is_guest, created_at, updated_at, locale, translation_group
		)
		SELECT
			id, slug, display_name, bio, avatar_media_id, website_url,
			user_id, is_guest, created_at, updated_at, ${defaultLocale}, id
		FROM _emdash_bylines
	`.execute(db);

	await db.schema.dropTable("_emdash_bylines").execute();
	await sql`ALTER TABLE _emdash_bylines_new RENAME TO _emdash_bylines`.execute(db);

	// Indexes from migration 031 dropped with the table; restore the
	// per-slug and per-display-name indexes. The partial unique on
	// user_id widens to (user_id, locale) so one CMS user can own one
	// byline per locale.
	await db.schema.createIndex("idx_bylines_slug").on("_emdash_bylines").column("slug").execute();
	await db.schema
		.createIndex("idx_bylines_display_name")
		.on("_emdash_bylines")
		.column("display_name")
		.execute();
	await sql`
		CREATE UNIQUE INDEX ${sql.ref("idx_bylines_user_id_locale_unique")}
		ON ${sql.ref("_emdash_bylines")} (user_id, locale)
		WHERE user_id IS NOT NULL
	`.execute(db);

	await db.schema
		.createIndex("idx__emdash_bylines_locale")
		.on("_emdash_bylines")
		.column("locale")
		.execute();
	await db.schema
		.createIndex("idx__emdash_bylines_translation_group")
		.on("_emdash_bylines")
		.column("translation_group")
		.execute();

	// One row per (translation_group, locale): the row-per-locale model
	// (PR #916) requires that each locale variant of a byline appears
	// exactly once in its translation group. `UNIQUE(slug, locale)` doesn't
	// catch the case where two siblings in the same group use different
	// slugs at the same locale — this partial unique does. `WHERE
	// translation_group IS NOT NULL` is defensive: post-040 every row has a
	// value, but the column is nullable in the schema.
	await sql`
		CREATE UNIQUE INDEX ${sql.ref("idx_bylines_group_locale_unique")}
		ON ${sql.ref("_emdash_bylines")} (translation_group, locale)
		WHERE translation_group IS NOT NULL
	`.execute(db);
}

async function remapPrimaryBylineIds(db: Kysely<unknown>): Promise<void> {
	// Walks every `ec_*` table and remaps `primary_byline_id` (row id →
	// translation_group). On a fresh install translation_group equals id
	// for every row, so the values look unchanged — but the column
	// semantics flip from "FK to _emdash_bylines.id" to "translation_group
	// in _emdash_bylines.translation_group". Once translations exist, the
	// remap is meaningful: a credit pointing at the en-row id still
	// resolves to the same byline group at every locale variant.
	const collections = await listTablesLike(db, "ec_%");
	for (const table of collections) {
		validateIdentifier(table, "content table");
		await sql`
			UPDATE ${sql.ref(table)} SET primary_byline_id = (
				SELECT translation_group FROM _emdash_bylines
				WHERE _emdash_bylines.id = ${sql.ref(table)}.primary_byline_id
			)
			WHERE primary_byline_id IS NOT NULL
				AND EXISTS (
					SELECT 1 FROM _emdash_bylines
					WHERE _emdash_bylines.id = ${sql.ref(table)}.primary_byline_id
				)
		`.execute(db);
	}
}

async function pgWidenBylines(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	const ref = sql.ref("_emdash_bylines");
	await sql`ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT ${sql.lit(defaultLocale)}`.execute(
		db,
	);
	await sql`ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS translation_group TEXT`.execute(db);
	await sql`UPDATE ${ref} SET translation_group = id WHERE translation_group IS NULL`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS ${sql.ref("idx__emdash_bylines_locale")} ON ${ref} (locale)`.execute(
		db,
	);
	await sql`
		CREATE INDEX IF NOT EXISTS ${sql.ref("idx__emdash_bylines_translation_group")}
		ON ${ref} (translation_group)
	`.execute(db);

	// Widen UNIQUE(slug) -> UNIQUE(slug, locale)
	const slugCons = await sql<{ conname: string }>`
		SELECT conname FROM pg_constraint c
		WHERE c.conrelid = '_emdash_bylines'::regclass AND c.contype = 'u'
			AND array_length(c.conkey, 1) = 1
			AND (
				SELECT array_agg(a.attname ORDER BY pos.ord)
				FROM unnest(c.conkey) WITH ORDINALITY AS pos(attnum, ord)
				JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = pos.attnum
			)::text[] = ARRAY['slug']
	`.execute(db);
	for (const c of slugCons.rows) {
		await sql`ALTER TABLE ${ref} DROP CONSTRAINT ${sql.ref(c.conname)}`.execute(db);
	}
	await sql`
		ALTER TABLE ${ref}
		ADD CONSTRAINT _emdash_bylines_slug_locale_unique UNIQUE (slug, locale)
	`.execute(db);

	// Replace the partial unique on (user_id) with (user_id, locale).
	await sql`DROP INDEX IF EXISTS idx_bylines_user_id_unique`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref("idx_bylines_user_id_locale_unique")}
		ON ${ref} (user_id, locale) WHERE user_id IS NOT NULL
	`.execute(db);

	// One row per (translation_group, locale): see SQLite branch above.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref("idx_bylines_group_locale_unique")}
		ON ${ref} (translation_group, locale) WHERE translation_group IS NOT NULL
	`.execute(db);
}

async function pgDropContentBylinesFk(db: Kysely<unknown>): Promise<void> {
	const fks = await sql<{ conname: string }>`
		SELECT conname FROM pg_constraint
		WHERE conrelid = '_emdash_content_bylines'::regclass AND contype = 'f'
	`.execute(db);
	for (const c of fks.rows) {
		await sql`ALTER TABLE _emdash_content_bylines DROP CONSTRAINT ${sql.ref(c.conname)}`.execute(
			db,
		);
	}
}

async function hasColumn(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
	const rows = await sql<{ name: string }>`PRAGMA table_info(${sql.ref(table)})`.execute(db);
	return rows.rows.some((r) => r.name === column);
}

/**
 * down() restores the FK on `_emdash_content_bylines.byline_id`. Rows whose
 * `byline_id` doesn't resolve to a (translation_group, defaultLocale) row in
 * `_emdash_bylines` would fail the rebuild after other tables are already
 * stripped — leaving the user mid-rollback. Surface dangling rows up front.
 */
async function assertContentBylinesResolve(
	db: Kysely<unknown>,
	defaultLocale: string,
): Promise<void> {
	const result = await sql<{ count: number | string }>`
		SELECT COUNT(*) AS count FROM _emdash_content_bylines cb
		WHERE NOT EXISTS (
			SELECT 1 FROM _emdash_bylines b
			WHERE b.translation_group = cb.byline_id AND b.locale = ${defaultLocale}
		)
	`.execute(db);
	const count = Number(result.rows[0]?.count ?? 0);
	if (count > 0) {
		throw new Error(
			`Cannot revert migration 040_byline_i18n: ` +
				`${count} row(s) in "_emdash_content_bylines" reference a translation_group ` +
				`with no row in "_emdash_bylines" at locale="${defaultLocale}". ` +
				`Clean up the dangling credits before rolling back.`,
		);
	}
}

/**
 * down() is destructive on multi-locale installs (dropping `locale` collapses
 * translated rows onto an ambiguous unique key). Refuse to run when any row
 * sits at a locale other than the configured defaultLocale.
 */
async function assertSingleLocale(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	const result = await sql<{ count: number | string }>`
		SELECT COUNT(*) AS count FROM _emdash_bylines WHERE locale != ${defaultLocale}
	`.execute(db);
	const count = Number(result.rows[0]?.count ?? 0);
	if (count > 0) {
		throw new Error(
			`Cannot revert migration 040_byline_i18n: ` +
				`${count} row(s) in "_emdash_bylines" use a non-default locale ` +
				`(defaultLocale="${defaultLocale}"). ` +
				`Reverting would drop them silently. Export translations first ` +
				`(or delete them) and re-run the rollback. ` +
				`See packages/core/src/database/migrations/040_byline_i18n.ts.`,
		);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const defaultLocale = getDefaultLocale();
	await assertSingleLocale(db, defaultLocale);
	await assertContentBylinesResolve(db, defaultLocale);

	if (isSqlite(db)) {
		// Indexes first to avoid blocking the table rebuilds.
		await sql.raw(`DROP INDEX IF EXISTS idx__emdash_bylines_locale`).execute(db);
		await sql.raw(`DROP INDEX IF EXISTS idx__emdash_bylines_translation_group`).execute(db);
		await sql.raw(`DROP INDEX IF EXISTS idx_bylines_user_id_locale_unique`).execute(db);
		await sql.raw(`DROP INDEX IF EXISTS idx_bylines_group_locale_unique`).execute(db);

		// Remap `_emdash_content_bylines.byline_id` and `ec_*.primary_byline_id`
		// from translation_group back to the row id of the defaultLocale
		// anchor. assertSingleLocale guarantees the mapping is 1:1, so the
		// rebuilt FK can validate every reference.
		await remapPrimaryBylineIdsDown(db, defaultLocale);
		await remapContentBylinesDown(db, defaultLocale);

		// Now safe to rebuild `_emdash_bylines` (strips locale +
		// translation_group, restores UNIQUE(slug) and the partial unique
		// on user_id alone).
		await rebuildBylinesDown(db);
		// And finally restore the FK on `_emdash_content_bylines.byline_id`.
		await restoreContentBylinesFk(db);
		return;
	}

	await remapPrimaryBylineIdsDown(db, defaultLocale);
	await sql`
		UPDATE _emdash_content_bylines
		SET byline_id = COALESCE(
			(SELECT b.id FROM _emdash_bylines b
			 WHERE b.translation_group = _emdash_content_bylines.byline_id
				 AND b.locale = ${defaultLocale}),
			byline_id
		)
	`.execute(db);

	await sql.raw(`DROP INDEX IF EXISTS idx__emdash_bylines_locale`).execute(db);
	await sql.raw(`DROP INDEX IF EXISTS idx__emdash_bylines_translation_group`).execute(db);
	await sql.raw(`DROP INDEX IF EXISTS idx_bylines_user_id_locale_unique`).execute(db);
	await sql.raw(`DROP INDEX IF EXISTS idx_bylines_group_locale_unique`).execute(db);
	await sql
		.raw(
			`ALTER TABLE "_emdash_bylines" DROP CONSTRAINT IF EXISTS _emdash_bylines_slug_locale_unique`,
		)
		.execute(db);
	await sql.raw(`ALTER TABLE "_emdash_bylines" DROP COLUMN IF EXISTS locale`).execute(db);
	await sql
		.raw(`ALTER TABLE "_emdash_bylines" DROP COLUMN IF EXISTS translation_group`)
		.execute(db);
	await sql
		.raw(`ALTER TABLE "_emdash_bylines" ADD CONSTRAINT _emdash_bylines_slug_unique UNIQUE (slug)`)
		.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref("idx_bylines_user_id_unique")}
		ON _emdash_bylines (user_id) WHERE user_id IS NOT NULL
	`.execute(db);
	await sql`
		ALTER TABLE _emdash_content_bylines
		ADD CONSTRAINT _emdash_content_bylines_byline_fk
		FOREIGN KEY (byline_id) REFERENCES _emdash_bylines(id) ON DELETE CASCADE
	`.execute(db);
}

async function remapPrimaryBylineIdsDown(
	db: Kysely<unknown>,
	defaultLocale: string,
): Promise<void> {
	const collections = await listTablesLike(db, "ec_%");
	for (const table of collections) {
		validateIdentifier(table, "content table");
		await sql`
			UPDATE ${sql.ref(table)}
			SET primary_byline_id = COALESCE(
				(SELECT b.id FROM _emdash_bylines b
				 WHERE b.translation_group = ${sql.ref(table)}.primary_byline_id
					 AND b.locale = ${defaultLocale}),
				primary_byline_id
			)
			WHERE primary_byline_id IS NOT NULL
		`.execute(db);
	}
}

async function remapContentBylinesDown(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	await sql`
		UPDATE _emdash_content_bylines
		SET byline_id = COALESCE(
			(SELECT b.id FROM _emdash_bylines b
			 WHERE b.translation_group = _emdash_content_bylines.byline_id
				 AND b.locale = ${defaultLocale}),
			byline_id
		)
	`.execute(db);
}

async function rebuildBylinesDown(db: Kysely<unknown>): Promise<void> {
	await sql.raw(`DROP TABLE IF EXISTS "_emdash_bylines_old"`).execute(db);
	await db.schema
		.createTable("_emdash_bylines_old")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("slug", "text", (c) => c.notNull().unique())
		.addColumn("display_name", "text", (c) => c.notNull())
		.addColumn("bio", "text")
		.addColumn("avatar_media_id", "text", (c) => c.references("media.id").onDelete("set null"))
		.addColumn("website_url", "text")
		.addColumn("user_id", "text", (c) => c.references("users.id").onDelete("set null"))
		.addColumn("is_guest", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.execute();
	await sql`
		INSERT INTO _emdash_bylines_old (
			id, slug, display_name, bio, avatar_media_id, website_url,
			user_id, is_guest, created_at, updated_at
		)
		SELECT
			id, slug, display_name, bio, avatar_media_id, website_url,
			user_id, is_guest, created_at, updated_at
		FROM _emdash_bylines
	`.execute(db);
	await db.schema.dropTable("_emdash_bylines").execute();
	await sql`ALTER TABLE _emdash_bylines_old RENAME TO _emdash_bylines`.execute(db);

	// Restore the indexes that existed pre-040.
	await db.schema.createIndex("idx_bylines_slug").on("_emdash_bylines").column("slug").execute();
	await db.schema
		.createIndex("idx_bylines_display_name")
		.on("_emdash_bylines")
		.column("display_name")
		.execute();
	await sql`
		CREATE UNIQUE INDEX ${sql.ref("idx_bylines_user_id_unique")}
		ON ${sql.ref("_emdash_bylines")} (user_id)
		WHERE user_id IS NOT NULL
	`.execute(db);
}

async function restoreContentBylinesFk(db: Kysely<unknown>): Promise<void> {
	await sql.raw(`DROP TABLE IF EXISTS "_emdash_content_bylines_old"`).execute(db);
	await db.schema
		.createTable("_emdash_content_bylines_old")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("collection_slug", "text", (c) => c.notNull())
		.addColumn("content_id", "text", (c) => c.notNull())
		.addColumn("byline_id", "text", (c) =>
			c.notNull().references("_emdash_bylines.id").onDelete("cascade"),
		)
		.addColumn("sort_order", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("role_label", "text")
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("content_bylines_unique", ["collection_slug", "content_id", "byline_id"])
		.execute();

	await sql`
		INSERT INTO _emdash_content_bylines_old
			(id, collection_slug, content_id, byline_id, sort_order, role_label, created_at)
		SELECT id, collection_slug, content_id, byline_id, sort_order, role_label, created_at
		FROM _emdash_content_bylines
	`.execute(db);

	await db.schema.dropTable("_emdash_content_bylines").execute();
	await sql`ALTER TABLE _emdash_content_bylines_old RENAME TO _emdash_content_bylines`.execute(db);

	await db.schema
		.createIndex("idx_content_bylines_content")
		.on("_emdash_content_bylines")
		.columns(["collection_slug", "content_id", "sort_order"])
		.execute();
	await db.schema
		.createIndex("idx_content_bylines_byline")
		.on("_emdash_content_bylines")
		.column("byline_id")
		.execute();
}
