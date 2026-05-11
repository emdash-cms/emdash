import type { Kysely } from "kysely";
import { sql } from "kysely";

import { getI18nConfig } from "../../i18n/config.js";
import { currentTimestamp, isSqlite } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

/**
 * i18n for menus + taxonomies. Adds `locale` + `translation_group` to system
 * tables and stores translation_groups (not row ids) in
 * `_emdash_menu_items.reference_id` and `content_taxonomies.taxonomy_id`.
 * Backfill locale and column DEFAULTs use the site's configured defaultLocale.
 */

function getDefaultLocale(): string {
	return getI18nConfig()?.defaultLocale ?? "en";
}

export async function up(db: Kysely<unknown>): Promise<void> {
	const defaultLocale = getDefaultLocale();

	if (isSqlite(db)) {
		// FKs off: rebuilding `taxonomies` would CASCADE-wipe `content_taxonomies`.
		await sql.raw(`PRAGMA foreign_keys = OFF`).execute(db);
		try {
			await rebuildMenus(db, defaultLocale);
			await addItemColumns(db, defaultLocale);
			await rebuildTaxonomies(db, defaultLocale);
			await rebuildTaxonomyDefs(db, defaultLocale);
			await rebuildContentTaxonomies(db);
			await remapMenuItemRefs(db);
		} finally {
			await sql.raw(`PRAGMA foreign_keys = ON`).execute(db);
		}
		return;
	}

	await pgWiden(db, "_emdash_menus", ["name"], ["name", "locale"], defaultLocale);
	await pgWiden(db, "_emdash_menu_items", null, null, defaultLocale);
	await pgWiden(db, "taxonomies", ["name", "slug"], ["name", "slug", "locale"], defaultLocale);
	await pgWiden(db, "_emdash_taxonomy_defs", ["name"], ["name", "locale"], defaultLocale);
	await pgRemapContentTaxonomies(db);
	await remapMenuItemRefs(db);
}

async function rebuildMenus(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	if (await hasColumn(db, "_emdash_menus", "locale")) return;
	await sql.raw(`DROP TABLE IF EXISTS "_emdash_menus_new"`).execute(db);

	await db.schema
		.createTable("_emdash_menus_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("locale", "text", (c) => c.notNull().defaultTo(defaultLocale))
		.addColumn("translation_group", "text")
		.addUniqueConstraint("_emdash_menus_name_locale_unique", ["name", "locale"])
		.execute();

	await sql`
		INSERT INTO _emdash_menus_new (id, name, label, created_at, updated_at, locale, translation_group)
		SELECT id, name, label, created_at, updated_at, ${defaultLocale}, id FROM _emdash_menus
	`.execute(db);

	await db.schema.dropTable("_emdash_menus").execute();
	await sql`ALTER TABLE _emdash_menus_new RENAME TO _emdash_menus`.execute(db);

	await db.schema
		.createIndex("idx__emdash_menus_locale")
		.on("_emdash_menus")
		.column("locale")
		.execute();
	await db.schema
		.createIndex("idx__emdash_menus_translation_group")
		.on("_emdash_menus")
		.column("translation_group")
		.execute();
}

async function addItemColumns(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	if (await hasColumn(db, "_emdash_menu_items", "locale")) return;

	await db.schema
		.alterTable("_emdash_menu_items")
		.addColumn("locale", "text", (c) => c.notNull().defaultTo(defaultLocale))
		.execute();
	await db.schema.alterTable("_emdash_menu_items").addColumn("translation_group", "text").execute();

	await sql`UPDATE _emdash_menu_items SET translation_group = id`.execute(db);

	await db.schema
		.createIndex("idx__emdash_menu_items_locale")
		.on("_emdash_menu_items")
		.column("locale")
		.execute();
	await db.schema
		.createIndex("idx__emdash_menu_items_translation_group")
		.on("_emdash_menu_items")
		.column("translation_group")
		.execute();
}

async function rebuildTaxonomies(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	if (await hasColumn(db, "taxonomies", "locale")) return;
	await sql.raw(`DROP TABLE IF EXISTS "taxonomies_new"`).execute(db);
	await sql`DROP INDEX IF EXISTS idx_taxonomies_name`.execute(db);

	await db.schema
		.createTable("taxonomies_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("slug", "text", (c) => c.notNull())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("parent_id", "text")
		.addColumn("data", "text")
		.addColumn("locale", "text", (c) => c.notNull().defaultTo(defaultLocale))
		.addColumn("translation_group", "text")
		.addUniqueConstraint("taxonomies_name_slug_locale_unique", ["name", "slug", "locale"])
		.addForeignKeyConstraint("taxonomies_parent_fk", ["parent_id"], "taxonomies", ["id"], (cb) =>
			cb.onDelete("set null"),
		)
		.execute();

	await sql`
		INSERT INTO taxonomies_new (id, name, slug, label, parent_id, data, locale, translation_group)
		SELECT id, name, slug, label, parent_id, data, ${defaultLocale}, id FROM taxonomies
	`.execute(db);

	await db.schema.dropTable("taxonomies").execute();
	await sql`ALTER TABLE taxonomies_new RENAME TO taxonomies`.execute(db);

	await db.schema.createIndex("idx_taxonomies_name").on("taxonomies").column("name").execute();
	await db.schema.createIndex("idx_taxonomies_locale").on("taxonomies").column("locale").execute();
	await db.schema
		.createIndex("idx_taxonomies_translation_group")
		.on("taxonomies")
		.column("translation_group")
		.execute();
}

async function rebuildTaxonomyDefs(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	if (await hasColumn(db, "_emdash_taxonomy_defs", "locale")) return;
	await sql.raw(`DROP TABLE IF EXISTS "_emdash_taxonomy_defs_new"`).execute(db);

	await db.schema
		.createTable("_emdash_taxonomy_defs_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("label_singular", "text")
		.addColumn("hierarchical", "integer", (c) => c.defaultTo(0))
		.addColumn("collections", "text")
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("locale", "text", (c) => c.notNull().defaultTo(defaultLocale))
		.addColumn("translation_group", "text")
		.addUniqueConstraint("_emdash_taxonomy_defs_name_locale_unique", ["name", "locale"])
		.execute();

	await sql`
		INSERT INTO _emdash_taxonomy_defs_new
			(id, name, label, label_singular, hierarchical, collections, created_at, locale, translation_group)
		SELECT id, name, label, label_singular, hierarchical, collections, created_at, ${defaultLocale}, id
		FROM _emdash_taxonomy_defs
	`.execute(db);

	await db.schema.dropTable("_emdash_taxonomy_defs").execute();
	await sql`ALTER TABLE _emdash_taxonomy_defs_new RENAME TO _emdash_taxonomy_defs`.execute(db);

	await db.schema
		.createIndex("idx__emdash_taxonomy_defs_locale")
		.on("_emdash_taxonomy_defs")
		.column("locale")
		.execute();
	await db.schema
		.createIndex("idx__emdash_taxonomy_defs_translation_group")
		.on("_emdash_taxonomy_defs")
		.column("translation_group")
		.execute();
}

async function rebuildContentTaxonomies(db: Kysely<unknown>): Promise<void> {
	// Drop the FK (taxonomy_id now points at translation_group, not a row id)
	// and remap the values.
	const fks = await sql<{ id: number }>`PRAGMA foreign_key_list(content_taxonomies)`.execute(db);
	if (fks.rows.length === 0) return;

	await sql.raw(`DROP TABLE IF EXISTS "content_taxonomies_new"`).execute(db);
	await db.schema
		.createTable("content_taxonomies_new")
		.addColumn("collection", "text", (c) => c.notNull())
		.addColumn("entry_id", "text", (c) => c.notNull())
		.addColumn("taxonomy_id", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("content_taxonomies_pk", ["collection", "entry_id", "taxonomy_id"])
		.execute();

	await sql`
		INSERT OR IGNORE INTO content_taxonomies_new (collection, entry_id, taxonomy_id)
		SELECT ct.collection, ct.entry_id, COALESCE(
			(SELECT t.translation_group FROM taxonomies t WHERE t.id = ct.taxonomy_id),
			ct.taxonomy_id
		)
		FROM content_taxonomies ct
	`.execute(db);

	await db.schema.dropTable("content_taxonomies").execute();
	await sql`ALTER TABLE content_taxonomies_new RENAME TO content_taxonomies`.execute(db);
}

async function remapMenuItemRefs(db: Kysely<unknown>): Promise<void> {
	// Items with `reference_collection IS NULL` are left untouched — the
	// runtime fallback in `menus/index.ts` resolves them by id.
	const collections = await sql<{ slug: string }>`SELECT slug FROM _emdash_collections`.execute(db);
	for (const { slug } of collections.rows) {
		validateIdentifier(slug, "collection slug");
		const ec = sql.ref(`ec_${slug}`);
		await sql`
			UPDATE _emdash_menu_items SET reference_id = (
				SELECT translation_group FROM ${ec} WHERE ${ec}.id = _emdash_menu_items.reference_id
			)
			WHERE reference_collection = ${slug} AND reference_id IS NOT NULL
				AND EXISTS (SELECT 1 FROM ${ec} WHERE ${ec}.id = _emdash_menu_items.reference_id)
		`.execute(db);
	}
	await sql`
		UPDATE _emdash_menu_items SET reference_id = (
			SELECT translation_group FROM taxonomies WHERE taxonomies.id = _emdash_menu_items.reference_id
		)
		WHERE type = 'taxonomy' AND reference_id IS NOT NULL
			AND EXISTS (SELECT 1 FROM taxonomies WHERE taxonomies.id = _emdash_menu_items.reference_id)
	`.execute(db);
}

async function pgWiden(
	db: Kysely<unknown>,
	table: string,
	oldCols: string[] | null,
	newCols: string[] | null,
	defaultLocale: string,
): Promise<void> {
	validateSystemIdent(table);
	const ref = sql.ref(table);
	await sql`ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT ${sql.lit(defaultLocale)}`.execute(
		db,
	);
	await sql`ALTER TABLE ${ref} ADD COLUMN IF NOT EXISTS translation_group TEXT`.execute(db);
	await sql`UPDATE ${ref} SET translation_group = id WHERE translation_group IS NULL`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${table}_locale`)} ON ${ref} (locale)`.execute(
		db,
	);
	await sql`
		CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${table}_translation_group`)} ON ${ref} (translation_group)
	`.execute(db);

	if (!oldCols || !newCols) return;
	for (const c of [...oldCols, ...newCols]) validateSystemIdent(c);
	const cons = await sql<{ conname: string }>`
		SELECT conname FROM pg_constraint c
		WHERE c.conrelid = ${table}::regclass AND c.contype = 'u'
			AND array_length(c.conkey, 1) = ${oldCols.length}
			AND (
				SELECT array_agg(a.attname ORDER BY pos.ord)
				FROM unnest(c.conkey) WITH ORDINALITY AS pos(attnum, ord)
				JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = pos.attnum
			)::text[] = ${oldCols}::text[]
	`.execute(db);
	for (const c of cons.rows) {
		await sql`ALTER TABLE ${ref} DROP CONSTRAINT ${sql.ref(c.conname)}`.execute(db);
	}
	const cols = sql.join(
		newCols.map((c) => sql.ref(c)),
		sql`, `,
	);
	await sql`
		ALTER TABLE ${ref}
		ADD CONSTRAINT ${sql.ref(`${table}_${newCols.join("_")}_unique`)} UNIQUE (${cols})
	`.execute(db);
}

async function pgRemapContentTaxonomies(db: Kysely<unknown>): Promise<void> {
	const fks = await sql<{ conname: string }>`
		SELECT conname FROM pg_constraint
		WHERE conrelid = 'content_taxonomies'::regclass AND contype = 'f'
	`.execute(db);
	for (const c of fks.rows) {
		await sql`ALTER TABLE content_taxonomies DROP CONSTRAINT ${sql.ref(c.conname)}`.execute(db);
	}
	await sql`
		UPDATE content_taxonomies SET taxonomy_id = t.translation_group
		FROM taxonomies t WHERE t.id = content_taxonomies.taxonomy_id
	`.execute(db);
}

async function hasColumn(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
	const rows = await sql<{ name: string }>`PRAGMA table_info(${sql.ref(table)})`.execute(db);
	return rows.rows.some((r) => r.name === column);
}

const SYSTEM_IDENT = /^[_a-z][a-z0-9_]*$/;
function validateSystemIdent(name: string): void {
	if (!SYSTEM_IDENT.test(name)) throw new Error(`Invalid identifier: "${name}"`);
}

/**
 * down() is destructive on multi-locale installs (dropping `locale` collapses
 * translated rows onto an ambiguous unique key). Refuse to run when any row
 * sits at a locale other than the configured defaultLocale.
 */
async function assertSingleLocale(db: Kysely<unknown>, defaultLocale: string): Promise<void> {
	const tables = ["_emdash_menus", "_emdash_menu_items", "taxonomies", "_emdash_taxonomy_defs"];
	for (const table of tables) {
		validateSystemIdent(table);
		const result = await sql<{ count: number | string }>`
			SELECT COUNT(*) AS count FROM ${sql.ref(table)} WHERE locale != ${defaultLocale}
		`.execute(db);
		const count = Number(result.rows[0]?.count ?? 0);
		if (count > 0) {
			throw new Error(
				`Cannot revert migration 036_i18n_menus_and_taxonomies: ` +
					`${count} row(s) in "${table}" use a non-default locale ` +
					`(defaultLocale="${defaultLocale}"). ` +
					`Reverting would drop them silently. Export translations first ` +
					`(or delete them) and re-run the rollback. ` +
					`See packages/core/src/database/migrations/036_i18n_menus_and_taxonomies.ts.`,
			);
		}
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const defaultLocale = getDefaultLocale();
	await assertSingleLocale(db, defaultLocale);

	const widenedTables = [
		"_emdash_menus",
		"_emdash_menu_items",
		"taxonomies",
		"_emdash_taxonomy_defs",
	];

	if (isSqlite(db)) {
		// FKs off — same reason as up().
		await sql.raw(`PRAGMA foreign_keys = OFF`).execute(db);
		try {
			// Indexes first: a locale index blocks DROP COLUMN on _emdash_menu_items.
			for (const t of widenedTables) {
				await sql.raw(`DROP INDEX IF EXISTS idx_${t}_locale`).execute(db);
				await sql.raw(`DROP INDEX IF EXISTS idx_${t}_translation_group`).execute(db);
			}

			await rebuildContentTaxonomiesDown(db, defaultLocale);
			await rebuildMenusDown(db);
			await rebuildMenuItemsDown(db);
			await rebuildTaxonomiesDown(db);
			await rebuildTaxonomyDefsDown(db);
		} finally {
			await sql.raw(`PRAGMA foreign_keys = ON`).execute(db);
		}
		return;
	}

	for (const t of widenedTables) {
		await sql.raw(`DROP INDEX IF EXISTS idx_${t}_locale`).execute(db);
		await sql.raw(`DROP INDEX IF EXISTS idx_${t}_translation_group`).execute(db);
		await sql.raw(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS locale`).execute(db);
		await sql.raw(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS translation_group`).execute(db);
	}
}

async function rebuildContentTaxonomiesDown(
	db: Kysely<unknown>,
	defaultLocale: string,
): Promise<void> {
	await sql.raw(`DROP TABLE IF EXISTS "content_taxonomies_new"`).execute(db);
	await db.schema
		.createTable("content_taxonomies_new")
		.addColumn("collection", "text", (c) => c.notNull())
		.addColumn("entry_id", "text", (c) => c.notNull())
		.addColumn("taxonomy_id", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("content_taxonomies_pk", ["collection", "entry_id", "taxonomy_id"])
		.addForeignKeyConstraint(
			"content_taxonomies_taxonomy_fk",
			["taxonomy_id"],
			"taxonomies",
			["id"],
			(cb) => cb.onDelete("cascade"),
		)
		.execute();

	// Map translation_group back to a row id (assertSingleLocale guarantees a 1:1 match).
	await sql`
		INSERT OR IGNORE INTO content_taxonomies_new (collection, entry_id, taxonomy_id)
		SELECT ct.collection, ct.entry_id, COALESCE(
			(SELECT t.id FROM taxonomies t WHERE t.translation_group = ct.taxonomy_id AND t.locale = ${defaultLocale}),
			ct.taxonomy_id
		)
		FROM content_taxonomies ct
	`.execute(db);

	await db.schema.dropTable("content_taxonomies").execute();
	await sql`ALTER TABLE content_taxonomies_new RENAME TO content_taxonomies`.execute(db);
}

async function rebuildMenusDown(db: Kysely<unknown>): Promise<void> {
	await sql.raw(`DROP TABLE IF EXISTS "_emdash_menus_old"`).execute(db);
	await db.schema
		.createTable("_emdash_menus_old")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull().unique())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.execute();
	await sql`
		INSERT INTO _emdash_menus_old (id, name, label, created_at, updated_at)
		SELECT id, name, label, created_at, updated_at FROM _emdash_menus
	`.execute(db);
	await db.schema.dropTable("_emdash_menus").execute();
	await sql`ALTER TABLE _emdash_menus_old RENAME TO _emdash_menus`.execute(db);
}

async function rebuildMenuItemsDown(db: Kysely<unknown>): Promise<void> {
	// No UNIQUE on (locale,…) here, so DROP COLUMN is enough.
	await sql.raw(`ALTER TABLE _emdash_menu_items DROP COLUMN locale`).execute(db);
	await sql.raw(`ALTER TABLE _emdash_menu_items DROP COLUMN translation_group`).execute(db);
}

async function rebuildTaxonomiesDown(db: Kysely<unknown>): Promise<void> {
	await sql.raw(`DROP TABLE IF EXISTS "taxonomies_old"`).execute(db);
	await db.schema
		.createTable("taxonomies_old")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("slug", "text", (c) => c.notNull())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("parent_id", "text")
		.addColumn("data", "text")
		.addUniqueConstraint("taxonomies_name_slug_unique", ["name", "slug"])
		.addForeignKeyConstraint(
			"taxonomies_parent_fk",
			["parent_id"],
			"taxonomies_old",
			["id"],
			(cb) => cb.onDelete("set null"),
		)
		.execute();
	await sql`
		INSERT INTO taxonomies_old (id, name, slug, label, parent_id, data)
		SELECT id, name, slug, label, parent_id, data FROM taxonomies
	`.execute(db);
	await db.schema.dropTable("taxonomies").execute();
	await sql`ALTER TABLE taxonomies_old RENAME TO taxonomies`.execute(db);
	await db.schema.createIndex("idx_taxonomies_name").on("taxonomies").column("name").execute();
}

async function rebuildTaxonomyDefsDown(db: Kysely<unknown>): Promise<void> {
	await sql.raw(`DROP TABLE IF EXISTS "_emdash_taxonomy_defs_old"`).execute(db);
	await db.schema
		.createTable("_emdash_taxonomy_defs_old")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull().unique())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("label_singular", "text")
		.addColumn("hierarchical", "integer", (c) => c.defaultTo(0))
		.addColumn("collections", "text")
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.execute();
	await sql`
		INSERT INTO _emdash_taxonomy_defs_old
			(id, name, label, label_singular, hierarchical, collections, created_at)
		SELECT id, name, label, label_singular, hierarchical, collections, created_at
		FROM _emdash_taxonomy_defs
	`.execute(db);
	await db.schema.dropTable("_emdash_taxonomy_defs").execute();
	await sql`ALTER TABLE _emdash_taxonomy_defs_old RENAME TO _emdash_taxonomy_defs`.execute(db);
}
