import { LOCALES, SOURCE_LOCALE } from "./locales.js";

export type { LocaleDefinition } from "./locales.js";

export const SUPPORTED_LOCALE_CODES = new Set(LOCALES.map((l) => l.code));

export const DEFAULT_LOCALE = SOURCE_LOCALE.code;

const LOCALE_DIRS = new Map(LOCALES.map((l) => [l.code, l.dir]));

/** Get the text direction for a locale code. Defaults to "ltr" if not specified. */
export function getLocaleDir(code: string): "ltr" | "rtl" {
	return LOCALE_DIRS.get(code) ?? "ltr";
}
