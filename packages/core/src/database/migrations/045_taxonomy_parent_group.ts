import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Store the parent's `translation_group` in `taxonomies.parent_id` instead of a
 * locale-bound row id.
 *
 * Before this, a term's `parent_id` pointed at one specific parent *row* (one
 * locale). A child translated in another locale could end up parented to a row
 * in a different locale, silently flattening that locale's tree (#1347). Every
 * other taxonomy i18n relationship already keys off `translation_group`
 * (`content_taxonomies.taxonomy_id`, `_emdash_menu_items.reference_id`), so this
 * aligns parentage with that model: a child links to the parent *concept* and
 * stays nested in whichever locale that parent has been translated into.
 *
 * Backfill rewrites every existing `parent_id` from the referenced parent row's
 * id to that parent's `translation_group`. A `translation_group` normally equals
 * its anchor row's id, so the self-FK on `parent_id` stays valid. We only
 * rewrite when that anchor row still exists; if a parent's anchor was deleted
 * but a sibling translation survives, the existing locale-bound id is left as-is
 * rather than rewritten to a dangling FK value. Such a child then renders as a
 * root rather than nested — an accepted degradation for an already-inconsistent
 * dataset (its `translation_group` already points at a deleted row, which breaks
 * `content_taxonomies` joins too). New deletes can't recreate this state: a
 * parent with children in any locale is undeletable. The correlated subquery is
 * a no-op for rows that already hold a group (an anchor row's id resolves to
 * itself), so the migration is safe to re-run.
 *
 * Dialect-independent: the correlated-subquery `UPDATE` runs on SQLite (incl.
 * D1) and Postgres alike.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE taxonomies
		SET parent_id = (
			SELECT p.translation_group FROM taxonomies p WHERE p.id = taxonomies.parent_id
		)
		WHERE parent_id IS NOT NULL
			AND EXISTS (
				SELECT 1 FROM taxonomies p
				WHERE p.id = taxonomies.parent_id
					AND p.translation_group IS NOT NULL
					-- Only rewrite to a translation_group that is itself a live row
					-- id, so the self-FK on parent_id can never dangle.
					AND EXISTS (SELECT 1 FROM taxonomies a WHERE a.id = p.translation_group)
			)
	`.execute(db);
}

/**
 * Map each `parent_id` group back to the row id of the parent in the same
 * locale (the pre-migration shape). Rows with no same-locale parent are left as
 * they are rather than nulled, so a rollback never silently detaches a subtree.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE taxonomies
		SET parent_id = COALESCE(
			(
				SELECT c.id FROM taxonomies c
				WHERE c.translation_group = taxonomies.parent_id
					AND c.locale = taxonomies.locale
			),
			parent_id
		)
		WHERE parent_id IS NOT NULL
	`.execute(db);
}
