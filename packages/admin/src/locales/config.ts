/**
 * Locale configuration for the admin UI runtime.
 *
 * Locale definitions are in `./locales.ts` -- the single source of truth
 * shared by this file, lingui.config.ts and lunaria.config.ts.
 */

import { ENABLED_LOCALES, SOURCE_LOCALE } from "./locales.js";

export type { LocaleDefinition as SupportedLocale } from "./locales.js";

function isValidLocale(code: string): boolean {
	try {
		const locale = new Intl.Locale(code);
		return locale.baseName !== "";
	} catch {
		if (import.meta.env.DEV) {
			throw new Error(`Invalid locale code: "${code}"`);
		}
		return false;
	}
}

/** Available locales at runtime, validated against BCP 47. */
export const SUPPORTED_LOCALES = ENABLED_LOCALES.filter((l) => isValidLocale(l.code));

export const SUPPORTED_LOCALE_CODES = new Set(SUPPORTED_LOCALES.map((l) => l.code));

export const DEFAULT_LOCALE = SOURCE_LOCALE.code;

/** Maps base language codes to supported locales (e.g. "pt" -> "pt-BR"). */
const BASE_LANGUAGE_MAP = new Map<string, string>();
for (const l of SUPPORTED_LOCALES) {
	const base = l.code.split("-")[0]!.toLowerCase();
	// First match wins -- if we have both "pt" and "pt-BR", exact wins via direct lookup.
	if (!BASE_LANGUAGE_MAP.has(base)) {
		BASE_LANGUAGE_MAP.set(base, l.code);
	}
}

/**
 * Find the best matching supported locale for a BCP 47 tag.
 * Canonicalizes via Intl.Locale so case differences (e.g. "pt-br" vs "pt-BR")
 * don't prevent matching. Falls back to base language (pt-PT -> pt-BR).
 */
function matchLocale(tag: string): string | undefined {
	const trimmed = tag.trim();
	if (!trimmed) return undefined;
	let canonical: string;
	try {
		canonical = new Intl.Locale(trimmed).baseName;
	} catch {
		return undefined;
	}
	if (SUPPORTED_LOCALE_CODES.has(canonical)) return canonical;
	const base = canonical.split("-")[0]!.toLowerCase();
	return BASE_LANGUAGE_MAP.get(base);
}

const LOCALE_LABELS = new Map(SUPPORTED_LOCALES.map((l) => [l.code, l.label]));

/** Get a display label for a locale code, falling back to uppercase code. */
export function getLocaleLabel(code: string): string {
	return LOCALE_LABELS.get(code) ?? code.toUpperCase();
}

const LOCALE_COOKIE_RE = /(?:^|;\s*)emdash-locale=([^;]+)/;

/**
 * Resolve the admin locale from a Request.
 * Priority: emdash-locale cookie -> Accept-Language -> DEFAULT_LOCALE.
 */
export function resolveLocale(request: Request): string {
	const cookieHeader = request.headers.get("cookie") ?? "";
	const cookieMatch = cookieHeader.match(LOCALE_COOKIE_RE);
	const cookieLocale = cookieMatch?.[1]?.trim() ?? "";

	if (SUPPORTED_LOCALE_CODES.has(cookieLocale)) return cookieLocale;

	const acceptLang = request.headers.get("accept-language") ?? "";
	for (const entry of acceptLang.split(",")) {
		const tag = entry.split(";")[0]!.trim();
		const matched = matchLocale(tag);
		if (matched) return matched;
	}

	return DEFAULT_LOCALE;
}
