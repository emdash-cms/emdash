import { sql, type Kysely } from "kysely";

const INDEX_NAME = "idx_taxonomies_translation_group_locale_unique";

export async function up(db: Kysely<unknown>): Promise<void> {
	const duplicates = await sql<{ id: string; translation_group: string }>`
		SELECT id, translation_group
		FROM (
			SELECT
				id,
				translation_group,
				ROW_NUMBER() OVER (
					PARTITION BY translation_group, locale
					ORDER BY id ASC
				) AS duplicate_rank
			FROM taxonomies
			WHERE translation_group IS NOT NULL
		) ranked
		WHERE duplicate_rank > 1
	`.execute(db);

	for (const duplicate of duplicates.rows) {
		// oxlint-disable-next-line no-await-in-loop -- each assignment copy must precede its group's update for restart safety
		await sql`
			INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
			SELECT collection, entry_id, ${duplicate.id}
			FROM content_taxonomies
			WHERE taxonomy_id = ${duplicate.translation_group}
			ON CONFLICT DO NOTHING
		`.execute(db);
		// oxlint-disable-next-line no-await-in-loop -- preserve the copy-before-update ordering above
		await sql`
			UPDATE taxonomies
			SET translation_group = ${duplicate.id}
			WHERE id = ${duplicate.id}
				AND translation_group = ${duplicate.translation_group}
		`.execute(db);
	}

	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref(INDEX_NAME)}
		ON taxonomies (translation_group, locale)
		WHERE translation_group IS NOT NULL
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP INDEX IF EXISTS ${sql.ref(INDEX_NAME)}`.execute(db);
}
