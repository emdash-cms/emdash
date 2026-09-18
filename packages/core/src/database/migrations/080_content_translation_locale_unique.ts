import type { Kysely } from "kysely";
import { sql } from "kysely";

import { indexExists, isPostgres, listTablesLike } from "../dialect-helpers.js";

const DUPLICATE_GROUP_BATCH_SIZE = 50;

interface DuplicateContentRow {
	id: string;
	translation_group: string;
	locale_key: string;
}

async function splitDuplicateLocales(db: Kysely<unknown>, tableName: string): Promise<void> {
	const collection = tableName.slice(3);

	while (true) {
		const duplicates = await sql<DuplicateContentRow>`
			WITH duplicate_groups AS (
				SELECT translation_group, lower(locale) AS locale_key
				FROM ${sql.ref(tableName)}
				WHERE deleted_at IS NULL AND translation_group IS NOT NULL
				GROUP BY translation_group, lower(locale)
				HAVING COUNT(*) > 1
				ORDER BY translation_group, lower(locale)
				LIMIT ${DUPLICATE_GROUP_BATCH_SIZE}
			)
			SELECT content.id, content.translation_group, lower(content.locale) AS locale_key
			FROM ${sql.ref(tableName)} AS content
			INNER JOIN duplicate_groups AS duplicate
				ON duplicate.translation_group = content.translation_group
				AND duplicate.locale_key = lower(content.locale)
			WHERE content.deleted_at IS NULL
			ORDER BY content.translation_group, lower(content.locale),
				CASE WHEN content.id = content.translation_group THEN 0 ELSE 1 END,
				content.created_at, content.id
		`.execute(db);

		if (duplicates.rows.length === 0) return;

		let previousGroupLocale: string | null = null;
		for (const row of duplicates.rows) {
			const groupLocale = `${row.translation_group}\0${row.locale_key}`;
			if (groupLocale !== previousGroupLocale) {
				previousGroupLocale = groupLocale;
				continue;
			}

			await sql`
				INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
				SELECT collection, ${row.id}, taxonomy_id
				FROM content_taxonomies
				WHERE collection = ${collection} AND entry_id = ${row.translation_group}
				ON CONFLICT (collection, entry_id, taxonomy_id) DO NOTHING
			`.execute(db);
			await sql`
				UPDATE ${sql.ref(tableName)}
				SET translation_group = ${row.id}
				WHERE id = ${row.id}
					AND deleted_at IS NULL
					AND translation_group = ${row.translation_group}
					AND lower(locale) = ${row.locale_key}
			`.execute(db);
		}
	}
}

export async function up(db: Kysely<unknown>): Promise<void> {
	for (const tableName of await listTablesLike(db, "ec_%")) {
		const indexName = `uidx_${tableName}_active_tg_locale`;
		const storedIndexName = isPostgres(db) ? indexName.slice(0, 63) : indexName;
		if (await indexExists(db, storedIndexName)) continue;
		await splitDuplicateLocales(db, tableName);
		await sql`
			CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref(indexName)}
			ON ${sql.ref(tableName)} (translation_group, lower(locale))
			WHERE deleted_at IS NULL AND translation_group IS NOT NULL
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const tableName of await listTablesLike(db, "ec_%")) {
		const indexName = `uidx_${tableName}_active_tg_locale`;
		const storedIndexName = isPostgres(db) ? indexName.slice(0, 63) : indexName;
		await sql`DROP INDEX IF EXISTS ${sql.ref(storedIndexName)}`.execute(db);
	}
}
