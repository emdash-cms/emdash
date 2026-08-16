import { sql, type Kysely } from "kysely";

import type { Database } from "../database/types.js";

const REPAIR_GUIDE =
	"https://docs.emdashcms.com/guides/internationalization/#repairing-taxonomy-locale-mismatches";

interface TaxonomyLocaleMismatch {
	source: "definitions" | "terms";
	locale: string;
}

export async function warnAboutUnconfiguredTaxonomyLocales(
	db: Kysely<Database>,
	configuredLocales: readonly string[],
): Promise<void> {
	const supportedLocales = configuredLocales.length > 0 ? configuredLocales : ["en"];
	const localeList = sql.join(supportedLocales.map((locale) => sql`${locale}`));
	const result = await sql<TaxonomyLocaleMismatch>`
		SELECT DISTINCT 'definitions' AS source, locale
		FROM _emdash_taxonomy_defs
		WHERE locale NOT IN (${localeList})
		UNION ALL
		SELECT DISTINCT 'terms' AS source, locale
		FROM taxonomies
		WHERE locale NOT IN (${localeList})
	`.execute(db);
	const mismatches = result.rows.toSorted(
		(a, b) => a.source.localeCompare(b.source) || a.locale.localeCompare(b.locale),
	);
	if (mismatches.length === 0) return;

	const details = mismatches.map(({ source, locale }) => `${source}: ${locale}`).join("; ");
	console.warn(
		`EmDash: Taxonomy rows use locales outside the configured locales (${supportedLocales.join(", ")}): ${details}. ` +
			`Locale-scoped reads may not return these rows. Review and repair them explicitly: ${REPAIR_GUIDE}`,
	);
}
