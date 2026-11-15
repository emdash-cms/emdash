import type { Kysely } from "kysely";
import { sql } from "kysely";

import { DEFAULT_LOCALE, getI18nConfig } from "../../i18n/config.js";

/**
 * Repair taxonomy rows created by migration 036 before the implicit locale was
 * changed from English to Spanish. Rows with an existing Spanish equivalent
 * are left untouched so the migration remains safe for translated content.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const config = getI18nConfig();
	const targetLocale = config?.defaultLocale ?? DEFAULT_LOCALE;
	if (
		targetLocale.toLowerCase() !== DEFAULT_LOCALE ||
		config?.locales.some((locale) => locale.toLowerCase() === "en")
	)
		return;

	await sql`
		UPDATE _emdash_taxonomy_defs
		SET locale = ${targetLocale}
		WHERE locale = 'en'
		  AND NOT EXISTS (
			SELECT 1 FROM _emdash_taxonomy_defs target
			WHERE target.name = _emdash_taxonomy_defs.name
			  AND target.locale = ${targetLocale}
		  )
	`.execute(db);

	await sql`
		UPDATE taxonomies
		SET locale = ${targetLocale}
		WHERE locale = 'en'
		  AND NOT EXISTS (
			SELECT 1 FROM taxonomies target
			WHERE target.name = taxonomies.name
			  AND target.slug = taxonomies.slug
			  AND target.locale = ${targetLocale}
		  )
	`.execute(db);
}

export async function down(): Promise<void> {
	// Data repair is intentionally forward-only.
}
