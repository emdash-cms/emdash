/**
 * Canonical locale definitions -- the single source of truth.
 *
 * This file is intentionally free of Vite/Astro APIs (`import.meta.env` etc.)
 * so it can be imported from CLI tools (Lingui, Lunaria) running in plain Node.
 *
 * To add a new locale:
 *   1. Add an entry here (with `enabled: false`).
 *   2. Run `pnpm locale:extract` to generate the PO file.
 *   3. Translate the strings in the PO file.
 *   4. Set `enabled: true` once coverage is sufficient.
 *
 * Lingui and Lunaria use all locales (for extraction and tracking).
 * The admin runtime only exposes locales with `enabled: true`.
 */

export interface LocaleDefinition {
	/** BCP 47 locale code (e.g. "en", "pt-BR"). */
	code: string;
	/** Human-readable label in the locale's own language. */
	label: string;
	/** Whether this locale is selectable in the admin UI. */
	enabled: boolean;
}

/**
 * All locales that have (or should have) a PO catalog.
 * First entry is the source/default locale.
 */
export const LOCALES: LocaleDefinition[] = [
	// Source locale first, then alphabetical by English name.
	{ code: "en", label: "English", enabled: true },
	{ code: "ar", label: "العربية", enabled: true }, // Arabic
	{ code: "zh-CN", label: "简体中文", enabled: true }, // Chinese (Simplified)
	{ code: "fr", label: "Français", enabled: true }, // French
	{ code: "de", label: "Deutsch", enabled: true }, // German
	{ code: "pt-BR", label: "Português (Brasil)", enabled: true }, // Portuguese (Brazil)
	// Pseudo-locale for i18n testing — never enabled in the admin UI by default.
	// Set VITE_EMDASH_PSEUDO_LOCALE=1 in .env to expose it in the locale switcher (dev only).
	{ code: "pseudo", label: "Pseudo", enabled: false },
];

/** The source locale (first entry). */
export const SOURCE_LOCALE = LOCALES[0]!;

/** All locale codes (for Lingui extraction / Lunaria tracking). */
export const LOCALE_CODES = LOCALES.map((l) => l.code);

/** Target locales -- everything except the source (for Lunaria). */
export const TARGET_LOCALES = LOCALES.slice(1);

/** Locales enabled in the admin UI. */
export const ENABLED_LOCALES = LOCALES.filter((l) => l.enabled);
