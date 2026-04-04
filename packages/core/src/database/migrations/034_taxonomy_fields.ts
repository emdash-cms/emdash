import { sql, type Kysely } from "kysely";

/**
 * Migration: Add custom fields to taxonomy definitions.
 *
 * Adds a `fields` TEXT column (JSON) to `_emdash_taxonomy_defs`.
 * This stores an array of field definitions like:
 *   [{ name: "color", label: "Color", type: "text" }]
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE _emdash_taxonomy_defs
		ADD COLUMN fields TEXT DEFAULT NULL
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("_emdash_taxonomy_defs").dropColumn("fields").execute();
}
