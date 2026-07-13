import { DirectionProvider } from "@cloudflare/kumo/primitives";
import { useLingui } from "@lingui/react";
import * as React from "react";

import { DEFAULT_LOCALE, getLocaleDir } from "./config.js";

interface LocaleDirectionProviderProps {
	children: React.ReactNode;
}

/**
 * Wraps the app with DirectionProvider and keeps `<html>` in sync with the
 * active Lingui locale. Only "en" ships today, but tracking `i18n.locale`
 * through the same `getLocaleDir` lookup packages/admin uses means adding an
 * RTL locale later doesn't require touching this component.
 */
export function LocaleDirectionProvider({ children }: LocaleDirectionProviderProps) {
	const { i18n } = useLingui();
	const locale = i18n.locale || DEFAULT_LOCALE;
	const dir = React.useMemo(() => getLocaleDir(locale), [locale]);

	React.useEffect(() => {
		document.documentElement.setAttribute("lang", locale);
		document.documentElement.setAttribute("dir", dir);
	}, [dir, locale]);

	return <DirectionProvider direction={dir}>{children}</DirectionProvider>;
}
