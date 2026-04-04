/**
 * I18n Provider and useTranslation hook.
 *
 * The provider is initialized with server-resolved locale + translations (from admin.astro).
 * Locale switching is client-side: dynamic import of the new locale JSON, cookie set, state
 * update — no page reload. The cookie ensures the server picks the right locale on next load.
 */

import * as React from "react";

import type { Translations } from "./types.js";

export interface SupportedLocale {
	code: string;
	label: string;
}

/** Available locales — extend this list as translations are added. */
export const SUPPORTED_LOCALES: SupportedLocale[] = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
];

const SUPPORTED_CODES = new Set(SUPPORTED_LOCALES.map((l) => l.code));

interface I18nContextValue {
	locale: string;
	translations: Translations;
	setLocale: (code: string) => void;
}

const I18nContext = React.createContext<I18nContextValue>({
	locale: "en",
	translations: {},
	setLocale: () => {},
});

export interface I18nProviderProps {
	locale: string;
	translations: Translations;
	children: React.ReactNode;
}

function setCookie(code: string) {
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `emdash-locale=${code}; Path=/_emdash; SameSite=Lax; Max-Age=31536000${secure}`;
}

/**
 * Load all namespace files for a locale and merge into a single Translations map.
 * Vite code-splits each JSON into its own chunk — only fetched on demand.
 */
async function loadLocale(code: string): Promise<Translations> {
	const namespaces = await Promise.all(localeNamespaces.map((ns) => ns(code)));
	let merged: Translations = {};
	for (const ns of namespaces) {
		merged = { ...merged, ...ns };
	}
	return merged;
}

/** Each function loads one namespace JSON for a given locale code. */
const localeNamespaces: Array<(code: string) => Promise<Translations>> = [
	async (code) => {
		const importers: Record<string, () => Promise<{ default: Translations }>> = {
			en: () => import("./locales/en/common.json"),
			fr: () => import("./locales/fr/common.json"),
		};
		return (await importers[code]!()).default;
	},
	async (code) => {
		const importers: Record<string, () => Promise<{ default: Translations }>> = {
			en: () => import("./locales/en/settings.json"),
			fr: () => import("./locales/fr/settings.json"),
		};
		return (await importers[code]!()).default;
	},
	async (code) => {
		const importers: Record<string, () => Promise<{ default: Translations }>> = {
			en: () => import("./locales/en/nav.json"),
			fr: () => import("./locales/fr/nav.json"),
		};
		return (await importers[code]!()).default;
	},
];

export function I18nProvider({
	locale: initialLocale,
	translations: initialTranslations,
	children,
}: I18nProviderProps) {
	const [locale, setLocaleState] = React.useState(initialLocale);
	const [translations, setTranslations] = React.useState(initialTranslations);

	const setLocale = React.useCallback(
		(code: string) => {
			if (!SUPPORTED_CODES.has(code) || code === locale) return;

			setCookie(code);
			setLocaleState(code);
			loadLocale(code).then(setTranslations);
		},
		[locale],
	);

	const value = React.useMemo(
		() => ({ locale, translations, setLocale }),
		[locale, translations, setLocale],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Get translation function, current locale, and locale switcher.
 * Optional namespace prefix: useTranslation('common') makes t('save') look up 'common.save'.
 */
export function useTranslation(namespace?: string) {
	const { locale, translations, setLocale } = React.useContext(I18nContext);

	const t = React.useCallback(
		(key: string, vars?: Record<string, string | number>) => {
			const fullKey = namespace ? `${namespace}.${key}` : key;
			let value = translations[fullKey] ?? fullKey;
			if (vars) {
				for (const [k, v] of Object.entries(vars)) {
					value = value.replaceAll(`{${k}}`, String(v));
				}
			}
			return value;
		},
		[namespace, translations],
	);

	return { t, locale, setLocale };
}
