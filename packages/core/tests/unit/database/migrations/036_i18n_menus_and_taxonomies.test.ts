import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/database/connection.js";
import { down, up } from "../../../../src/database/migrations/036_i18n_menus_and_taxonomies.js";
import type { Database } from "../../../../src/database/types.js";
import { setI18nConfig } from "../../../../src/i18n/config.js";

/**
 * Seed the four pre-i18n tables that migration 036 widens, plus the support
 * tables it reads (`_emdash_collections`, `ec_posts`). Mirrors the schema
 * shape immediately before this migration runs in production.
 */
async function seedPreMigrationSchema(db: Kysely<Database>): Promise<void> {
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
			created_at TEXT DEFAULT (datetime('now'))
		)
	`.execute(db);

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

describe("036_i18n_menus_and_taxonomies migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await seedPreMigrationSchema(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("up()", () => {
		it("adds locale + translation_group to every widened table", async () => {
			await up(db);

			const tables = await db.introspection.getTables();
			for (const name of [
				"_emdash_menus",
				"_emdash_menu_items",
				"taxonomies",
				"_emdash_taxonomy_defs",
			]) {
				const cols = tables.find((t) => t.name === name)?.columns.map((c) => c.name) ?? [];
				expect(cols, `${name} should expose locale`).toContain("locale");
				expect(cols, `${name} should expose translation_group`).toContain("translation_group");
			}
		});

		it("creates locale + translation_group indexes on every widened table", async () => {
			await up(db);

			const indexes = await sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'
			`.execute(db);
			const names = new Set(indexes.rows.map((r) => r.name));

			for (const table of [
				"_emdash_menus",
				"_emdash_menu_items",
				"taxonomies",
				"_emdash_taxonomy_defs",
			]) {
				expect(names, `missing locale index for ${table}`).toContain(`idx_${table}_locale`);
				expect(names, `missing translation_group index for ${table}`).toContain(
					`idx_${table}_translation_group`,
				);
			}
		});

		it("backfills translation_group = id for pre-existing rows", async () => {
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Main')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_menu_items (id, menu_id, type, label) VALUES ('mi1', 'm1', 'custom', 'Home')`.execute(
				db,
			);
			await sql`INSERT INTO taxonomies (id, name, slug, label) VALUES ('t1', 'category', 'news', 'News')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_taxonomy_defs (id, name, label) VALUES ('d1', 'category', 'Categories')`.execute(
				db,
			);

			await up(db);

			const checks: Array<{ table: string; id: string }> = [
				{ table: "_emdash_menus", id: "m1" },
				{ table: "_emdash_menu_items", id: "mi1" },
				{ table: "taxonomies", id: "t1" },
				{ table: "_emdash_taxonomy_defs", id: "d1" },
			];
			for (const { table, id } of checks) {
				const row = await sql<{ locale: string; translation_group: string | null }>`
					SELECT locale, translation_group FROM ${sql.ref(table)} WHERE id = ${id}
				`.execute(db);
				expect(row.rows[0]?.locale, `${table} locale`).toBe("en");
				expect(row.rows[0]?.translation_group, `${table} translation_group`).toBe(id);
			}
		});

		it("widens the menu unique key from (name) to (name, locale)", async () => {
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Main')`.execute(
				db,
			);
			await up(db);

			// Same name, different locale must now be allowed.
			await sql`
				INSERT INTO _emdash_menus (id, name, label, locale, translation_group)
				VALUES ('m2', 'main', 'Principal', 'es', 'm1')
			`.execute(db);

			// Same name and same locale must still conflict.
			await expect(
				sql`
					INSERT INTO _emdash_menus (id, name, label, locale, translation_group)
					VALUES ('m3', 'main', 'Other', 'es', 'm1')
				`.execute(db),
			).rejects.toThrow();
		});

		it("remaps content_taxonomies.taxonomy_id to taxonomies.translation_group", async () => {
			// Two terms in different translation groups.
			await sql`INSERT INTO taxonomies (id, name, slug, label) VALUES ('t1', 'category', 'news', 'News')`.execute(
				db,
			);
			await sql`INSERT INTO taxonomies (id, name, slug, label) VALUES ('t2', 'category', 'sports', 'Sports')`.execute(
				db,
			);
			await sql`INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id) VALUES ('posts', 'p1', 't1')`.execute(
				db,
			);
			await sql`INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id) VALUES ('posts', 'p1', 't2')`.execute(
				db,
			);

			await up(db);

			const groups = await sql<{ taxonomy_id: string }>`
				SELECT taxonomy_id FROM content_taxonomies WHERE entry_id = 'p1' ORDER BY taxonomy_id
			`.execute(db);
			// On a fresh install translation_group == id, so values look unchanged.
			expect(groups.rows.map((r) => r.taxonomy_id).sort()).toEqual(["t1", "t2"]);

			// FK to taxonomies.id is gone: insert via group whose row id differs.
			await sql`
				INSERT INTO taxonomies (id, name, slug, label, locale, translation_group)
				VALUES ('t1-es', 'category', 'noticias', 'Noticias', 'es', 't1')
			`.execute(db);
			await sql`
				INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
				VALUES ('posts', 'p2', 't1')
			`.execute(db);
			const orphan = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM content_taxonomies WHERE entry_id = 'p2'
			`.execute(db);
			expect(Number(orphan.rows[0]?.count ?? 0)).toBe(1);
		});

		it("remaps _emdash_menu_items.reference_id for content references", async () => {
			await sql`INSERT INTO _emdash_collections (slug) VALUES ('posts')`.execute(db);
			// Pre-existing post whose translation_group was minted by migration 019.
			await sql`INSERT INTO ec_posts (id, locale, translation_group) VALUES ('post-1', 'en', 'group-1')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Main')`.execute(
				db,
			);
			await sql`
				INSERT INTO _emdash_menu_items (id, menu_id, type, label, reference_collection, reference_id)
				VALUES ('mi-content', 'm1', 'page', 'Home', 'posts', 'post-1')
			`.execute(db);

			await up(db);

			const item = await sql<{ reference_id: string }>`
				SELECT reference_id FROM _emdash_menu_items WHERE id = 'mi-content'
			`.execute(db);
			expect(item.rows[0]?.reference_id).toBe("group-1");
		});

		it("remaps _emdash_menu_items.reference_id for taxonomy references", async () => {
			await sql`
				INSERT INTO taxonomies (id, name, slug, label)
				VALUES ('term-1', 'category', 'news', 'News')
			`.execute(db);
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Main')`.execute(
				db,
			);
			await sql`
				INSERT INTO _emdash_menu_items (id, menu_id, type, label, reference_id)
				VALUES ('mi-tax', 'm1', 'taxonomy', 'News', 'term-1')
			`.execute(db);

			await up(db);

			const item = await sql<{ reference_id: string }>`
				SELECT reference_id FROM _emdash_menu_items WHERE id = 'mi-tax'
			`.execute(db);
			// On a fresh install the remap is a no-op (translation_group == id).
			expect(item.rows[0]?.reference_id).toBe("term-1");
		});

		it("leaves items with reference_collection NULL untouched (runtime fallback handles them)", async () => {
			await sql`INSERT INTO _emdash_collections (slug) VALUES ('posts')`.execute(db);
			await sql`INSERT INTO ec_posts (id, locale, translation_group) VALUES ('post-1', 'en', 'group-1')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Main')`.execute(
				db,
			);
			// Legacy item: type='post' with reference_collection NULL. We can't
			// migrate without guessing the collection slug, so the value is left
			// as the original row id — runtime fallback resolves it directly.
			await sql`
				INSERT INTO _emdash_menu_items (id, menu_id, type, label, reference_collection, reference_id)
				VALUES ('mi-legacy', 'm1', 'post', 'Post', NULL, 'post-1')
			`.execute(db);

			await up(db);

			const item = await sql<{ reference_id: string }>`
				SELECT reference_id FROM _emdash_menu_items WHERE id = 'mi-legacy'
			`.execute(db);
			expect(item.rows[0]?.reference_id).toBe("post-1");
		});

		it("leaves menu items with non-resolving references untouched", async () => {
			await sql`INSERT INTO _emdash_collections (slug) VALUES ('posts')`.execute(db);
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Main')`.execute(
				db,
			);
			// reference_id points at a post that doesn't exist — should stay as-is.
			await sql`
				INSERT INTO _emdash_menu_items (id, menu_id, type, label, reference_collection, reference_id)
				VALUES ('mi-orphan', 'm1', 'page', 'Ghost', 'posts', 'post-missing')
			`.execute(db);

			await up(db);

			const item = await sql<{ reference_id: string | null }>`
				SELECT reference_id FROM _emdash_menu_items WHERE id = 'mi-orphan'
			`.execute(db);
			expect(item.rows[0]?.reference_id).toBe("post-missing");
		});
	});

	describe("down()", () => {
		it("reverts cleanly on a single-locale install", async () => {
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Main')`.execute(
				db,
			);
			await sql`INSERT INTO taxonomies (id, name, slug, label) VALUES ('t1', 'category', 'news', 'News')`.execute(
				db,
			);
			await up(db);

			await down(db);

			const tables = await db.introspection.getTables();
			for (const name of [
				"_emdash_menus",
				"_emdash_menu_items",
				"taxonomies",
				"_emdash_taxonomy_defs",
			]) {
				const cols = tables.find((t) => t.name === name)?.columns.map((c) => c.name) ?? [];
				expect(cols, `${name} should not retain locale after rollback`).not.toContain("locale");
				expect(cols, `${name} should not retain translation_group after rollback`).not.toContain(
					"translation_group",
				);
			}

			const indexes = await sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_locale'
			`.execute(db);
			expect(indexes.rows).toHaveLength(0);

			// Original rows survived the rollback.
			const menu = await sql<{ name: string }>`
				SELECT name FROM _emdash_menus WHERE id = 'm1'
			`.execute(db);
			expect(menu.rows[0]?.name).toBe("main");
		});

		it("refuses to rollback when non-default-locale rows exist", async () => {
			await up(db);
			await sql`
				INSERT INTO _emdash_menus (id, name, label, locale, translation_group)
				VALUES ('m-fr', 'main', 'Principal', 'fr', 'm-fr')
			`.execute(db);

			await expect(down(db)).rejects.toThrow(/non-default locale/i);

			// Assertion fired before any destructive work — schema still post-up.
			const cols = (await db.introspection.getTables())
				.find((t) => t.name === "_emdash_menus")
				?.columns.map((c) => c.name);
			expect(cols).toContain("locale");
		});

		it("names the offending table in the rollback error", async () => {
			await up(db);
			await sql`
				INSERT INTO taxonomies (id, name, slug, label, locale, translation_group)
				VALUES ('t-es', 'category', 'noticias', 'Noticias', 'es', 't-es')
			`.execute(db);

			await expect(down(db)).rejects.toThrow(/taxonomies/);
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
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Principal')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_menu_items (id, menu_id, type, label) VALUES ('mi1', 'm1', 'custom', 'Inicio')`.execute(
				db,
			);
			await sql`INSERT INTO taxonomies (id, name, slug, label) VALUES ('t1', 'category', 'noticias', 'Noticias')`.execute(
				db,
			);
			await sql`INSERT INTO _emdash_taxonomy_defs (id, name, label) VALUES ('d1', 'category', 'Categorías')`.execute(
				db,
			);

			await up(db);

			for (const table of [
				"_emdash_menus",
				"_emdash_menu_items",
				"taxonomies",
				"_emdash_taxonomy_defs",
			]) {
				const row = await sql<{ locale: string }>`
					SELECT locale FROM ${sql.ref(table)} LIMIT 1
				`.execute(db);
				expect(row.rows[0]?.locale, `${table} should backfill with 'es'`).toBe("es");
			}
		});

		it("rolls back cleanly when only defaultLocale rows exist", async () => {
			await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('m1', 'main', 'Principal')`.execute(
				db,
			);
			await up(db);

			await expect(down(db)).resolves.not.toThrow();

			const cols = (await db.introspection.getTables())
				.find((t) => t.name === "_emdash_menus")
				?.columns.map((c) => c.name);
			expect(cols).not.toContain("locale");
		});

		it("blocks rollback when rows use a locale other than the configured default", async () => {
			await up(db);
			await sql`
				INSERT INTO _emdash_menus (id, name, label, locale, translation_group)
				VALUES ('m-en', 'main', 'Main', 'en', 'm-en')
			`.execute(db);

			await expect(down(db)).rejects.toThrow(/defaultLocale="es"/);
		});
	});
});
