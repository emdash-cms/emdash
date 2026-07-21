import type { Kysely } from "kysely";
import { sql } from "kysely";

import { getI18nConfig } from "../../i18n/config.js";
import { listTablesLike } from "../dialect-helpers.js";

/** Canonicalize stored locales to the casing used by the site configuration. */
export async function up(db: Kysely<unknown>): Promise<void> {
	const locales = getI18nConfig()?.locales ?? [];
	if (locales.length === 0) return;

	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const table = sql.ref(tableName);
		const slug = tableName.slice("ec_".length);
		for (const locale of locales) {
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

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Not reversible: the original casing is not recoverable.
}
