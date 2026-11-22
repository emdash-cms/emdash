import { getI18nConfig } from "emdash";

/**
 * The default locale from the site's Astro `i18n` config, if it names a
 * language this runtime can format. Callers fall back to English when it's
 * undefined.
 */
export function getSiteLocale(): string | undefined {
	const locale = getI18nConfig()?.defaultLocale;
	if (!locale) return undefined;
	try {
		return Intl.DateTimeFormat.supportedLocalesOf(locale)[0];
	} catch {
		// Malformed tags such as "pt_BR" throw instead of matching nothing.
		return undefined;
	}
}

const DATE_FORMATS_KEY = Symbol.for("emdash:template-blog:date-formats");
const g = globalThis as Record<symbol, unknown>;
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
const dateFormats = (g[DATE_FORMATS_KEY] ??= new Map()) as Map<string, Intl.DateTimeFormat>;

/** Formats a date in the site's locale, or in US English without one. */
export function formatDate(date: Date, month: "long" | "short"): string {
	if (Number.isNaN(date.getTime())) return "Invalid Date";
	const locale = getSiteLocale() ?? "en-US";
	const key = `${locale}:${month}`;
	let format = dateFormats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(locale, { year: "numeric", month, day: "numeric" });
		dateFormats.set(key, format);
	}
	return format.format(date);
}
