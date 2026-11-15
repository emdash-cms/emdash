import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

const REPAIR_GUIDE =
	"https://docs.emdashcms.com/guides/internationalization/#repairing-taxonomy-locale-mismatches";

interface TaxonomyLocaleMismatch {
	source: "definitions" | "terms";
	locale: string;
	ids: string[];
}

interface TaxonomyLocaleRow {
	id: string;
	locale: string;
}

export async function warnAboutUnconfiguredTaxonomyLocales(
	db: Kysely<Database>,
	configuredLocales: readonly string[],
	definitionLocales?: readonly string[],
	definitionRows?: readonly TaxonomyLocaleRow[],
): Promise<void> {
	const supportedLocales = configuredLocales.length > 0 ? configuredLocales : ["es"];
	const definitions =
		definitionRows ??
		(definitionLocales === undefined
			? await db
					.selectFrom("_emdash_taxonomy_defs")
					.select(["id", "locale"])
					.where("locale", "not in", supportedLocales)
					.execute()
			: [...new Set(definitionLocales)]
					.filter((locale) => !supportedLocales.includes(locale))
					.map((locale) => ({ id: "unknown", locale })));
	const termRows = await db
		.selectFrom("taxonomies")
		.select(["id", "locale"])
		.where("locale", "not in", supportedLocales)
		.execute();
	const mismatches = [
		...definitions.map(({ id, locale }) => ({ source: "definitions" as const, locale, id })),
		...termRows.map(({ id, locale }) => ({ source: "terms" as const, locale, id })),
	]
		.reduce<TaxonomyLocaleMismatch[]>((all, row) => {
			const existing = all.find((item) => item.source === row.source && item.locale === row.locale);
			if (existing) existing.ids.push(row.id);
			else all.push({ source: row.source, locale: row.locale, ids: [row.id] });
			return all;
		}, [])
		.toSorted((a, b) => a.source.localeCompare(b.source) || a.locale.localeCompare(b.locale));
	if (mismatches.length === 0) return;

	const details = mismatches
		.map(({ source, locale, ids }) => `${source}: ${locale} (ids: ${ids.join(", ")})`)
		.join("; ");
	console.warn(
		`EmDash: Taxonomy rows use locales outside the configured locales (${supportedLocales.join(", ")}): ${details}. ` +
			`Locale-scoped reads may not return these rows. Review and repair them explicitly: ${REPAIR_GUIDE}`,
	);
}
