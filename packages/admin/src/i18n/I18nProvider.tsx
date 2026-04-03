// packages/admin/src/i18n/I18nProvider.tsx

import * as React from "react";

import type { Translations } from "./types.js";

interface I18nContextValue {
	locale: string;
	translations: Translations;
}

const I18nContext = React.createContext<I18nContextValue>({
	locale: "en",
	translations: {},
});

export interface I18nProviderProps {
	locale: string;
	translations: Translations;
	children: React.ReactNode;
}

export function I18nProvider({ locale, translations, children }: I18nProviderProps) {
	const value = React.useMemo(() => ({ locale, translations }), [locale, translations]);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Get translation function and current locale.
 * Optional namespace prefix: useTranslation('common') makes t('save') look up 'common.save'.
 */
export function useTranslation(namespace?: string) {
	const { locale, translations } = React.useContext(I18nContext);

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

	return { t, locale };
}
