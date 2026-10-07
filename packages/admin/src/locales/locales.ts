/**
 * Canonical locale definitions -- the single source of truth.
 *
 * This file is intentionally free of Vite/Astro APIs (`import.meta.env` etc.)
 * so it can be imported from CLI tools (Lingui, Lunaria) running in plain Node.
 *
 * To add a new locale:
 *   1. Add an entry here (with `enabled: false`) and its `dateLocale` loader.
 *   2. Run `pnpm locale:extract` to generate the PO file.
 *   3. Translate the strings in the PO file.
 *   4. Set `enabled: true` once coverage is sufficient.
 *
 * Lingui and Lunaria use all locales (for extraction and tracking).
 * The admin runtime only exposes locales with `enabled: true`.
 */

import type { DayPickerLocale } from "react-day-picker/locale";

export interface LocaleDefinition {
	/** BCP 47 locale code (e.g. "en", "pt-BR"). */
	code: string;
	/** Human-readable label in the locale's own language. */
	label: string;
	/** Whether this locale is selectable in the admin UI. */
	enabled: boolean;
	/** Text direction for this locale. Defaults to "ltr" if not specified. */
	dir?: "rtl" | "ltr";
	/**
	 * Loads the date-fns locale, with DayPicker labels, for calendars and date
	 * formatting. Omit it to use US English. Keep it a lazy `import()` with a
	 * literal path: this file is loaded on the server and by the Lingui and
	 * Lunaria CLIs, which must not load every date locale.
	 */
	dateLocale?: () => Promise<DayPickerLocale>;
}

/**
 * All locales that have (or should have) a PO catalog.
 * First entry is the source/default locale.
 */
export const LOCALES: LocaleDefinition[] = [
	// Source locale first, then alphabetical by English name.
	{ code: "en", label: "English", enabled: true },
	// Arabic
	{
		code: "ar",
		label: "العربية",
		enabled: true,
		dir: "rtl",
		dateLocale: () => import("react-day-picker/locale/ar").then((m) => m.ar),
	},
	// Basque
	{
		code: "eu",
		label: "Euskara",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/eu").then((m) => m.eu),
	},
	// Bengali
	{
		code: "bn",
		label: "বাংলা",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/bn").then((m) => m.bn),
	},
	// Catalan
	{
		code: "ca",
		label: "Català",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/ca").then((m) => m.ca),
	},
	// Chinese (Simplified)
	{
		code: "zh-CN",
		label: "简体中文",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/zh-CN").then((m) => m.zhCN),
	},
	// Chinese (Traditional)
	{
		code: "zh-TW",
		label: "繁體中文",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/zh-TW").then((m) => m.zhTW),
	},
	// Czech
	{
		code: "cs",
		label: "Čeština",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/cs").then((m) => m.cs),
	},
	// Danish
	{
		code: "da",
		label: "Dansk",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/da").then((m) => m.da),
	},
	// Dutch
	{
		code: "nl",
		label: "Nederlands",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/nl").then((m) => m.nl),
	},
	// English (United Kingdom)
	{
		code: "en-GB",
		label: "English (UK)",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/en-GB").then((m) => m.enGB),
	},
	// Farsi (also known as Persian)
	{
		code: "fa",
		label: "فارسی",
		enabled: true,
		dir: "rtl",
		dateLocale: () => import("react-day-picker/locale/fa-IR").then((m) => m.faIR),
	},
	// French
	{
		code: "fr",
		label: "Français",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/fr").then((m) => m.fr),
	},
	// Georgian
	{
		code: "ka",
		label: "ქართული",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/ka").then((m) => m.ka),
	},
	// German
	{
		code: "de",
		label: "Deutsch",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/de").then((m) => m.de),
	},
	// Hebrew
	{
		code: "he",
		label: "עברית",
		enabled: true,
		dir: "rtl",
		dateLocale: () => import("react-day-picker/locale/he").then((m) => m.he),
	},
	// Hindi
	{
		code: "hi",
		label: "हिन्दी",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/hi").then((m) => m.hi),
	},
	// Hungarian
	{
		code: "hu",
		label: "Magyar",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/hu").then((m) => m.hu),
	},
	// Indonesian
	{
		code: "id",
		label: "Bahasa Indonesia",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/id").then((m) => m.id),
	},
	// Japanese
	{
		code: "ja",
		label: "日本語",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/ja").then((m) => m.ja),
	},
	// Korean
	{
		code: "ko",
		label: "한국어",
		enabled: false,
		dateLocale: () => import("react-day-picker/locale/ko").then((m) => m.ko),
	},
	// Norwegian Bokmål
	{
		code: "nb",
		label: "Norsk bokmål",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/nb").then((m) => m.nb),
	},
	// Polish
	{
		code: "pl",
		label: "Polski",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/pl").then((m) => m.pl),
	},
	// Portuguese (Brazil)
	{
		code: "pt-BR",
		label: "Português (Brasil)",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/pt-BR").then((m) => m.ptBR),
	},
	// Portuguese (Portugal)
	{
		code: "pt-PT",
		label: "Português (Portugal)",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/pt").then((m) => m.pt),
	},
	// Serbian (Latin script)
	{
		code: "sr-Latn",
		label: "Srpski",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/sr-Latn").then((m) => m.srLatn),
	},
	// Spanish (Latin America)
	{
		code: "es-419",
		label: "Español (Latinoamérica)",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/es").then((m) => m.es),
	},
	// Spanish (Spain) - BCP 47
	{
		code: "es-ES",
		label: "Español (España)",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/es").then((m) => m.es),
	},
	// Swedish
	{
		code: "sv",
		label: "Svenska",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/sv").then((m) => m.sv),
	},
	// Thai
	{
		code: "th",
		label: "ไทย",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/th").then((m) => m.th),
	},
	// Turkish
	{
		code: "tr",
		label: "Türkçe",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/tr").then((m) => m.tr),
	},
	// Ukrainian
	{
		code: "uk",
		label: "Українська",
		enabled: true,
		dateLocale: () => import("react-day-picker/locale/uk").then((m) => m.uk),
	},
	// Pseudo-locale for i18n testing - never enabled in the admin UI by default.
	// Set EMDASH_PSEUDO_LOCALE=1 in .env to expose it in the locale switcher (dev only).
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
