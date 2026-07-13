/**
 * Canonical locale definitions for the console — the single source of
 * truth, referenced by lingui.config.ts. Mirrors packages/admin's
 * locales.ts shape so a future locale addition follows the same steps
 * (add an entry, extract, translate, enable), but starts English-only.
 */

export interface LocaleDefinition {
	/** BCP 47 locale code (e.g. "en", "ar"). */
	code: string;
	/** Human-readable label in the locale's own language. */
	label: string;
	/** Text direction for this locale. Defaults to "ltr" if not specified. */
	dir?: "rtl" | "ltr";
}

/** First entry is the source/default locale. */
export const LOCALES: LocaleDefinition[] = [{ code: "en", label: "English" }];

export const SOURCE_LOCALE = LOCALES[0]!;
