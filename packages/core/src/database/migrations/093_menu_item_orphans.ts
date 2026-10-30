import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Moves menu items whose parent is missing from their menu to the top level.
 * The public menu already renders them there; the admin editor and site
 * exports only walk down from top-level items, so they could not reach them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE _emdash_menu_items SET parent_id = NULL
		WHERE parent_id IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM _emdash_menu_items AS parent
				WHERE parent.id = _emdash_menu_items.parent_id
					AND parent.menu_id = _emdash_menu_items.menu_id
			)
	`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
