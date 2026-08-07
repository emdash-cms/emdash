import type { Kysely } from "kysely";

/**
 * Add composite `idx_taxonomies_name_locale` on `taxonomies(name, locale)` (#1723).
 *
 * `TaxonomyRepository.findByName` filters `WHERE name = ? AND locale = ?`, but
 * the only indexes were the single-column `idx_taxonomies_name(name)` and
 * `idx_taxonomies_locale(locale)`. On SQLite/D1 with no `sqlite_stat1` the
 * planner picks `idx_taxonomies_locale` and reads *every* term in the locale,
 * filtering `name` in memory — once per facet rendered. On a site where one
 * taxonomy dominates a locale, each small facet still walks the whole locale.
 *
 * The composite resolves both equalities, so the planner searches only the one
 * taxonomy's terms. Its leftmost prefix (`name`) also serves every name-only
 * lookup, so it supersedes `idx_taxonomies_name`, which we drop. The
 * single-column `idx_taxonomies_locale` stays for locale-only lookups.
 *
 * Strictly additive: no query changes, and the dropped index is fully covered
 * by the new composite's prefix. Create-before-drop keeps name lookups indexed
 * at every point. Both statements are idempotent so a partial apply can retry.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx_taxonomies_name_locale")
		.ifNotExists()
		.on("taxonomies")
		.columns(["name", "locale"])
		.execute();

	await db.schema.dropIndex("idx_taxonomies_name").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx_taxonomies_name")
		.ifNotExists()
		.on("taxonomies")
		.column("name")
		.execute();

	await db.schema.dropIndex("idx_taxonomies_name_locale").ifExists().execute();
}
