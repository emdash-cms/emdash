import type { Kysely } from "kysely";

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
	definitionLocales?: readonly string[],
): Promise<void> {
	const supportedLocales = configuredLocales.length > 0 ? configuredLocales : ["en"];
	const definitionRows =
		definitionLocales === undefined
			? await db
					.selectFrom("_emdash_taxonomy_defs")
					.select("locale")
					.distinct()
					.where("locale", "not in", supportedLocales)
					.execute()
			: [...new Set(definitionLocales)]
					.filter((locale) => !supportedLocales.includes(locale))
					.map((locale) => ({ locale }));
	const termRows = await db
		.selectFrom("taxonomies")
		.select("locale")
		.distinct()
		.where("locale", "not in", supportedLocales)
		.execute();
	const mismatches: TaxonomyLocaleMismatch[] = [
		...definitionRows.map(({ locale }) => ({ source: "definitions" as const, locale })),
		...termRows.map(({ locale }) => ({ source: "terms" as const, locale })),
	].toSorted((a, b) => a.source.localeCompare(b.source) || a.locale.localeCompare(b.locale));
	if (mismatches.length === 0) return;

	const details = mismatches.map(({ source, locale }) => `${source}: ${locale}`).join("; ");
	console.warn(
		`EmDash: Taxonomy rows use locales outside the configured locales (${supportedLocales.join(", ")}): ${details}. ` +
			`Locale-scoped reads may not return these rows. Review and repair them explicitly: ${REPAIR_GUIDE}`,
	);
}
