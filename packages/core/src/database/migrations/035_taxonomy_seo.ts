import { sql, type Kysely } from "kysely";

/**
 * Migration: Add SEO support flag to taxonomy definitions.
 *
 * Adds a `has_seo` INTEGER column to `_emdash_taxonomy_defs`.
 * When enabled, taxonomy terms can have SEO metadata stored in
 * `_emdash_seo` with collection="taxonomy:{name}".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE _emdash_taxonomy_defs
		ADD COLUMN has_seo INTEGER NOT NULL DEFAULT 0
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("_emdash_taxonomy_defs").dropColumn("has_seo").execute();
}
