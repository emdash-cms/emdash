import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";

/** Rewrite stored locales to the exact casing used by the site configuration. */
export async function repairLocaleCasing(
	db: Kysely<Database>,
	configuredLocales: readonly string[],
): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const table = sql.ref(tableName);
		const slug = tableName.slice("ec_".length);
		for (const locale of configuredLocales) {
			await sql`
				UPDATE ${table} AS target
				SET locale = ${locale}
				WHERE lower(target.locale) = lower(${locale})
					AND target.locale != ${locale}
					AND NOT EXISTS (
						SELECT 1
						FROM ${table} AS existing
						WHERE existing.slug = target.slug AND existing.locale = ${locale}
					)
					AND target.id = (
						SELECT MIN(candidate.id)
						FROM ${table} AS candidate
						WHERE candidate.slug = target.slug
							AND lower(candidate.locale) = lower(${locale})
							AND candidate.locale != ${locale}
					)
			`.execute(db);

			await sql`
				UPDATE content_taxonomies AS pivot
				SET locale = ${locale}
				WHERE pivot.collection = ${slug}
					AND lower(pivot.locale) = lower(${locale})
					AND pivot.locale != ${locale}
					AND EXISTS (
						SELECT 1
						FROM ${table} AS content
						WHERE content.id = pivot.entry_id AND content.locale = ${locale}
					)
			`.execute(db);
		}
	}
}
