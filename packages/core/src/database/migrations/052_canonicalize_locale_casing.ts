import type { Kysely } from "kysely";
import { sql } from "kysely";

import { getI18nConfig } from "../../i18n/config.js";
import { listTablesLike } from "../dialect-helpers.js";

/**
 * Backfill migration for #1572.
 *
 * `contentCreateBody`'s `locale` field used to lowercase every explicit
 * value (`localeCode`'s `.transform()`), so a site with a configured locale
 * like `zh-TW` could end up with rows stored as `zh-tw`. The transform was
 * removed so canonical-cased queries (`?locale=zh-TW`) now match, but that
 * only fixes future writes -- existing rows already stored under the
 * lowercased form are still missed by an exact-match `locale = 'zh-TW'`
 * filter.
 *
 * For every `ec_*` content table, canonicalize any row whose `locale`
 * case-insensitively matches a configured locale but isn't stored in that
 * locale's canonical casing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const locales = getI18nConfig()?.locales ?? [];
	if (locales.length === 0) return;

	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const table = sql.ref(tableName);
		for (const locale of locales) {
			await sql`
				UPDATE ${table}
				SET locale = ${locale}
				WHERE lower(locale) = lower(${locale}) AND locale != ${locale}
			`.execute(db);
		}
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Not reversible: the original (incorrectly lowercased) casing is not
	// recoverable, and re-lowercasing would reintroduce the bug this fixes.
}
