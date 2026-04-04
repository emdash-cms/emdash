import { sql, type Kysely } from "kysely";

/**
 * Migration: Add visibility column to all content tables.
 *
 * Adds a `visibility` TEXT column (defaults to 'public') to every `ec_*`
 * content table. This column controls who can see published content:
 *   - 'public'  — everyone (default, backwards-compatible)
 *   - 'members' — authenticated users only
 *   - 'private' — author + editors/admins only
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Discover all existing collection slugs
	const collections = await sql<{ slug: string }>`
		SELECT slug FROM _emdash_collections
	`.execute(db);

	for (const { slug } of collections.rows) {
		const tableName = `ec_${slug}`;

		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
		`.execute(db);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_visibility`)}
			ON ${sql.ref(tableName)} (visibility)
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const collections = await sql<{ slug: string }>`
		SELECT slug FROM _emdash_collections
	`.execute(db);

	for (const { slug } of collections.rows) {
		const tableName = `ec_${slug}`;

		await sql`
			DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_visibility`)}
		`.execute(db);

		await db.schema.alterTable(tableName).dropColumn("visibility").execute();
	}
}
