/**
 * i18n configuration — single source of truth for supported locales and namespaces.
 *
 * Imported by both the React provider (client) and admin.astro (server).
 */

export interface SupportedLocale {
	code: string;
	label: string;
}

/** Validate a locale code against the Intl.Locale API (BCP 47). */
function validateLocaleCode(code: string): string | void {
	try {
		return new Intl.Locale(code).baseName;
	} catch {
		if (import.meta.env.DEV) {
			throw new Error(`Invalid locale code: "${code}"`);
		}
	}
}

/** Available locales — extend this list as translations are added. */
export const SUPPORTED_LOCALES: SupportedLocale[] = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
].filter((l) => validateLocaleCode(l.code));

export const SUPPORTED_LOCALE_CODES = new Set(SUPPORTED_LOCALES.map((l) => l.code));

export const DEFAULT_LOCALE = SUPPORTED_LOCALES[0]!.code;
