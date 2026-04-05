import { useLingui } from "@lingui/react";
import * as React from "react";

import { SUPPORTED_LOCALE_CODES } from "./config.js";

function setCookie(code: string) {
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `emdash-locale=${code}; Path=/_emdash; SameSite=Lax; Max-Age=31536000${secure}`;
}

/**
 * Get the current locale and a function to switch locales.
 * Loads the new catalog dynamically and sets a cookie for server-side persistence.
 */
export function useLocale() {
	const { i18n } = useLingui();

	const setLocale = React.useCallback(
		(code: string) => {
			if (code === i18n.locale || !SUPPORTED_LOCALE_CODES.has(code)) return;
			setCookie(code);
			void import(`./${code}/messages.po`)
				.then(({ messages }) => i18n.loadAndActivate({ locale: code, messages }))
				.catch(() => {
					// Revert cookie on failure so the user isn't stuck
					setCookie(i18n.locale);
				});
		},
		[i18n],
	);

	return { locale: i18n.locale, setLocale };
}
