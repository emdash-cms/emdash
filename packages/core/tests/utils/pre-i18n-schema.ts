import { type Kysely, sql } from "kysely";

import type { Database } from "../../src/database/types.js";

/**
 * Seed the four pre-i18n tables that migration 036 widens, plus the support
 * tables it reads (`_emdash_collections`, `ec_posts`). Mirrors the schema
 * shape immediately before this migration runs in production.
 */
export async function seedPreI18nSchema(db: Kysely<Database>): Promise<void> {
	await sql`
		CREATE TABLE _emdash_menus (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			label TEXT NOT NULL,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)
	`.execute(db);

	await sql`
		CREATE TABLE _emdash_menu_items (
			id TEXT PRIMARY KEY,
			menu_id TEXT NOT NULL,
			parent_id TEXT,
			sort_order INTEGER NOT NULL DEFAULT 0,
			type TEXT NOT NULL,
			reference_collection TEXT,
			reference_id TEXT,
			custom_url TEXT,
			label TEXT NOT NULL,
			title_attr TEXT,
			target TEXT,
			css_classes TEXT,
			created_at TEXT DEFAULT (datetime('now')),
			CONSTRAINT menu_items_menu_fk FOREIGN KEY (menu_id)
				REFERENCES _emdash_menus(id) ON DELETE CASCADE,
			CONSTRAINT menu_items_parent_fk FOREIGN KEY (parent_id)
				REFERENCES _emdash_menu_items(id) ON DELETE CASCADE
		)
	`.execute(db);

	await sql`CREATE INDEX idx_menu_items_menu ON _emdash_menu_items(menu_id, sort_order)`.execute(
		db,
	);
	await sql`CREATE INDEX idx_menu_items_parent ON _emdash_menu_items(parent_id)`.execute(db);

	await sql`
		CREATE TABLE taxonomies (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			slug TEXT NOT NULL,
			label TEXT NOT NULL,
			parent_id TEXT,
			data TEXT,
			UNIQUE(name, slug),
			FOREIGN KEY (parent_id) REFERENCES taxonomies(id) ON DELETE SET NULL
		)
	`.execute(db);

	await sql`
		CREATE TABLE _emdash_taxonomy_defs (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			label TEXT NOT NULL,
			label_singular TEXT,
			hierarchical INTEGER DEFAULT 0,
			collections TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		)
	`.execute(db);

	await sql`
		CREATE TABLE content_taxonomies (
			collection TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			taxonomy_id TEXT NOT NULL,
			PRIMARY KEY (collection, entry_id, taxonomy_id),
			FOREIGN KEY (taxonomy_id) REFERENCES taxonomies(id) ON DELETE CASCADE
		)
	`.execute(db);

	await sql`
		CREATE TABLE _emdash_collections (
			slug TEXT PRIMARY KEY
		)
	`.execute(db);

	// translation_group is added to ec_* by migration 019; 036 reads it during remap.
	await sql`
		CREATE TABLE ec_posts (
			id TEXT PRIMARY KEY,
			locale TEXT NOT NULL DEFAULT 'en',
			translation_group TEXT
		)
	`.execute(db);
}
