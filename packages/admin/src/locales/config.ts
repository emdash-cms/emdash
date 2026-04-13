/**
 * Locale configuration — single source of truth for supported locales.
 *
 * Imported by both the Lingui provider (client) and admin.astro (server).
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
	/* First item is the default locale */
	{ code: "en", label: "English" },
	{ code: "de", label: "Deutsch" },
	{ code: "ar", label: "العربية" },
].filter((l) => validateLocaleCode(l.code));

export const SUPPORTED_LOCALE_CODES = new Set(SUPPORTED_LOCALES.map((l) => l.code));

export const DEFAULT_LOCALE = SUPPORTED_LOCALES[0]!.code;

const LOCALE_LABELS = new Map(SUPPORTED_LOCALES.map((l) => [l.code, l.label]));

/** Get a display label for a locale code, falling back to uppercase code. */
export function getLocaleLabel(code: string): string {
	return LOCALE_LABELS.get(code) ?? code.toUpperCase();
}

const LOCALE_COOKIE_RE = /(?:^|;\s*)emdash-locale=([^;]+)/;

/**
 * Resolve the admin locale from a Request.
 * Priority: emdash-locale cookie → Accept-Language → DEFAULT_LOCALE.
 */
export function resolveLocale(request: Request): string {
	const cookieHeader = request.headers.get("cookie") ?? "";
	const cookieMatch = cookieHeader.match(LOCALE_COOKIE_RE);
	const cookieLocale = cookieMatch?.[1]?.trim() ?? "";

	if (SUPPORTED_LOCALE_CODES.has(cookieLocale)) return cookieLocale;

	const acceptLang = request.headers.get("accept-language") ?? "";
	for (const entry of acceptLang.split(",")) {
		const tag = entry.split(";")[0]!.trim().split("-")[0]!.toLowerCase();
		if (SUPPORTED_LOCALE_CODES.has(tag)) return tag;
	}

	return DEFAULT_LOCALE;
}
