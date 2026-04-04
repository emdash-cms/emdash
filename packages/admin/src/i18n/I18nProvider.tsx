/**
 * I18n Provider and useTranslation hook.
 *
 * The provider is initialized with server-resolved locale + translations (from admin.astro).
 * Locale switching is client-side: dynamic import of the new locale JSON, cookie set, state
 * update — no page reload. The cookie ensures the server picks the right locale on next load.
 */

import * as React from "react";

import { DEFAULT_LOCALE, SUPPORTED_LOCALE_CODES } from "./config.js";
import type { Namespace, Translations, TranslationKeyMap } from "./types.js";

interface I18nContextValue {
	locale: string;
	translations: Translations;
	setLocale: (code: string) => void;
}

const I18nContext = React.createContext<I18nContextValue>({
	locale: DEFAULT_LOCALE,
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
 * All locale JSON files, discovered at build time by Vite.
 * Lazy-loaded: each file becomes its own chunk, fetched on demand.
 */
const localeModules = import.meta.glob<{ default: Translations }>("./locales/*/*.json");

/**
 * Load all namespace files for a locale and merge into a single Translations map.
 */
async function loadLocale(code: string): Promise<Translations> {
	const prefix = `./locales/${code}/`;
	const entries = Object.entries(localeModules).filter(([path]) => path.startsWith(prefix));
	const results = await Promise.all(
		entries.map(([, importer]) => importer().then((m) => m.default)),
	);
	let merged: Translations = {};
	for (const ns of results) {
		merged = { ...merged, ...ns };
	}
	return merged;
}

export function I18nProvider({
	locale: initialLocale,
	translations: initialTranslations,
	children,
}: I18nProviderProps) {
	const [locale, setLocaleState] = React.useState(initialLocale);
	const [translations, setTranslations] = React.useState(initialTranslations);

	const setLocale = React.useCallback(
		(code: string) => {
			if (!SUPPORTED_LOCALE_CODES.has(code) || code === locale) return;

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
export function useTranslation<NS extends Namespace>(
	namespace: NS,
): {
	t: (key: TranslationKeyMap[NS], vars?: Record<string, string | number>) => string;
	locale: string;
	setLocale: (code: string) => void;
};
export function useTranslation(): { locale: string; setLocale: (code: string) => void };
export function useTranslation(namespace?: string) {
	const { locale, translations, setLocale } = React.useContext(I18nContext);

	const t = React.useCallback(
		(key: string, vars?: Record<string, string | number>) => {
			const fullKey = namespace ? `${namespace}.${key}` : key;
			let value = translations[fullKey] ?? fullKey;

			if (value === fullKey && import.meta.env.DEV) {
				console.warn(`[useTranslation] key not found: ${fullKey}`);
			}

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
