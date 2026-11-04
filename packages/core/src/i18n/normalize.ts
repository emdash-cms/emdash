import { resolveConfiguredLocale, type I18nConfig } from "./config.js";

export interface AstroLocaleObject {
	path: string;
	codes: readonly string[];
}

export interface AstroI18nInput {
	defaultLocale: string;
	locales: readonly (string | AstroLocaleObject)[];
	fallback?: Readonly<Record<string, string | undefined>>;
	routing?: string | { prefixDefaultLocale?: boolean };
}

export function normalizeAstroI18n(config: AstroI18nInput | null | undefined): I18nConfig | null {
	if (!config) return null;

	const aliases = config.locales.flatMap((locale) =>
		typeof locale === "string" ? [] : locale.codes.map((code) => [code, locale.path]),
	);
	const normalized: I18nConfig = {
		...(aliases.length > 0 ? { localeAliases: Object.fromEntries(aliases) } : {}),
		defaultLocale: config.defaultLocale,
		locales: config.locales.map((locale) => (typeof locale === "string" ? locale : locale.path)),
		fallback: config.fallback
			? Object.fromEntries(
					Object.entries(config.fallback).filter(
						(entry): entry is [string, string] => entry[1] !== undefined,
					),
				)
			: undefined,
		prefixDefaultLocale:
			typeof config.routing === "object" ? (config.routing.prefixDefaultLocale ?? false) : false,
	};
	normalized.defaultLocale = resolveConfiguredLocale(config.defaultLocale, normalized);
	if (normalized.fallback) {
		normalized.fallback = Object.fromEntries(
			Object.entries(normalized.fallback).map(([from, to]) => [
				resolveConfiguredLocale(from, normalized),
				resolveConfiguredLocale(to, normalized),
			]),
		);
	}
	return normalized;
}
