import { sql, type Kysely } from "kysely";

/**
 * Adds `group` and `sort_order` columns to `_emdash_collections`
 * for organizing collections in admin UI sidebar.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE _emdash_collections
		ADD COLUMN "group" TEXT;
	`.execute(db);

	await sql`
		ALTER TABLE _emdash_collections
		ADD COLUMN sort_order INTEGER DEFAULT 0;
	`.execute(db);

	// Create index for sorting
	await sql`
		CREATE INDEX idx_collections_group_sort
		ON _emdash_collections ("group", sort_order);
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP INDEX IF EXISTS idx_collections_group_sort;`.execute(db);
	await sql`ALTER TABLE _emdash_collections DROP COLUMN "group";`.execute(db);
	await sql`ALTER TABLE _emdash_collections DROP COLUMN sort_order;`.execute(db);
}
