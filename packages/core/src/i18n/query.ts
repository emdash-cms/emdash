import { sql, type SqlBool } from "kysely";

import { getI18nConfig, getLocaleCandidates } from "./config.js";

/** Match both canonical paths and code-stamped rows written by older versions. */
export function localeMatches(column: string, locale: string) {
	const candidates = getLocaleCandidates(locale);
	if (candidates.length === 1) return sql<SqlBool>`${sql.ref(column)} = ${candidates[0]}`;
	return sql<SqlBool>`${sql.ref(column)} IN (${sql.join(candidates)})`;
}

/** Prefer the configured path, then its Astro codes in configuration order. */
export function localeOrder(column: string, locale: string) {
	const candidates = getLocaleCandidates(locale);
	return sql<number>`CASE lower(${sql.ref(column)}) ${sql.join(
		candidates.map((candidate, rank) => sql`WHEN ${candidate.toLowerCase()} THEN ${sql.lit(rank)}`),
		sql` `,
	)} ELSE ${sql.lit(candidates.length)} END`;
}

/** Compare locale columns without losing rows stored under an Astro code. */
export function canonicalLocaleColumn(column: string) {
	const aliases = (getI18nConfig()?.locales ?? []).flatMap((locale) =>
		getLocaleCandidates(locale)
			.slice(1)
			.map((code) => ({ code, locale })),
	);
	if (aliases.length === 0) return sql<string>`${sql.ref(column)}`;
	return sql<string>`CASE lower(${sql.ref(column)}) ${sql.join(
		aliases.map(({ code, locale }) => sql`WHEN ${code.toLowerCase()} THEN ${locale.toLowerCase()}`),
		sql` `,
	)} ELSE lower(${sql.ref(column)}) END`;
}

/** Rank a row's code within its own configured locale; paths always rank first. */
export function storedLocaleOrder(column: string) {
	const aliases = (getI18nConfig()?.locales ?? []).flatMap((locale) =>
		getLocaleCandidates(locale)
			.slice(1)
			.map((code, index) => ({ code, rank: index + 1 })),
	);
	if (aliases.length === 0) return sql<number>`0`;
	return sql<number>`CASE lower(${sql.ref(column)}) ${sql.join(
		aliases.map(({ code, rank }) => sql`WHEN ${code.toLowerCase()} THEN ${sql.lit(rank)}`),
		sql` `,
	)} ELSE 0 END`;
}
